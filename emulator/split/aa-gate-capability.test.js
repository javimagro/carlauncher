'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createGateProbe } = require('../../native/javi-carlab/controller-lease');

test('ID8 package loads the AA controller gate in the service that owns Hmi8', () => {
    const repo = require('../../mgu-repo.json');
    const gate = repo.components.find(item => item.id === 'javi-ccu-gate');
    const app = repo.components.find(item => item.id === 'javi_carlauncher');
    assert.deepEqual(gate.mguHmi, ['ID8']);
    assert.equal(gate.preload.unit, 'hmi8.service');
    assert.equal(gate.preload.process, 'Hmi8');
    assert.equal(app.requires[gate.id], gate.version);
});

function elf(marker) {
    const bytes = Buffer.alloc(128); bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    bytes.writeUInt16LE(3, 16); bytes.writeUInt16LE(62, 18);
    if (marker) bytes.write('BMWLauncherAAKnobGate1\0', 64, 'ascii');
    return bytes;
}
function fixture(t, marked, options = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-aa-gate-'));
    const proc = path.join(directory, '42'), file = path.join(directory, 'javi-ccu-gate.so');
    fs.mkdirSync(proc); fs.writeFileSync(path.join(proc, 'comm'), 'Hmi8\n'); fs.writeFileSync(file, elf(marked));
    // NTFS file identifiers can exceed Number.MAX_SAFE_INTEGER. Model Linux
    // inodes explicitly rather than weakening the production precision guard.
    const inodes = new Map(), io = Object.create(fs);
    const inode = info => {
        const key = String(info.dev) + ':' + String(info.ino);
        if (!inodes.has(key)) inodes.set(key, inodes.size + 100);
        return inodes.get(key);
    };
    const normalize = info => Object.assign(Object.create(Object.getPrototypeOf(info)), info, { ino: inode(info) });
    io.stat = (name, cb) => fs.stat(name, (error, info) => cb(error, error ? undefined : normalize(info)));
    io.fstat = (fd, cb) => fs.fstat(fd, (error, info) => cb(error, error ? undefined : normalize(info)));
    const mapping = (inode, suffix = '') => fs.writeFileSync(path.join(proc, 'maps'),
        '7f000000-7f001000 r-xp 00001000 08:01 ' + (inode === undefined ? normalize(fs.statSync(file)).ino : inode) + ' ' + file.replace(/\\/g, '/') + suffix + '\n');
    mapping();
    t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true }); });
    return { directory, proc, file, mapping, io, inode: () => normalize(fs.statSync(file)).ino,
        probe: createGateProbe(directory, Object.assign({ fs: io }, options)) };
}
test('AA gate capability rejects an old mapped preload and an installed replacement until its inode is mapped', async t => {
    const f = fixture(t, false); assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false);
    const oldInode = f.inode();
    fs.writeFileSync(f.file + '.new', elf(true)); fs.renameSync(f.file + '.new', f.file);
    assert.notEqual(f.inode(), oldInode);
    assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false, 'new disk version is not the old mapped inode');
    f.mapping(); assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), true);
    f.mapping(undefined, ' (deleted)'); assert.equal(await f.probe(), false); assert.equal(f.probe.aaReady(), false);
});
test('AA gate cache avoids binary reads per poll but always rechecks mapping, inode and process identity', async t => {
    const f = fixture(t, true), original = f.io.read; let reads = 0;
    f.io.read = function () { reads++; return original.apply(this, arguments); };
    assert.equal(await f.probe(), true); assert(f.probe.aaReady());
    const first = reads; assert(first > 0);
    assert.equal(await f.probe(), true); assert(f.probe.aaReady()); assert.equal(reads, first);
    f.mapping(f.inode() + 1); assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false);
    f.mapping(Number.MAX_SAFE_INTEGER + 1); assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false, 'imprecise inode cannot prove mapped identity');
    f.mapping(); assert.equal(await f.probe(), true); assert(f.probe.aaReady()); assert.equal(reads, first);
    fs.writeFileSync(path.join(f.proc, 'comm'), 'not-Hmi8\n'); assert.equal(await f.probe(), false); assert.equal(f.probe.aaReady(), false);
});
test('AA gate capability fails closed for unreadable, absent, malformed or ambiguous mapped binaries', async t => {
    const f = fixture(t, true), original = f.io.open;
    f.io.open = function (file, flags, callback) { if (path.resolve(file) === f.file) return process.nextTick(() => callback(new Error('EACCES'))); return original.apply(this, arguments); };
    assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false);
    f.io.open = original;
    fs.writeFileSync(f.file, Buffer.from('BMWLauncherAAKnobGate1\0')); f.mapping();
    assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false);
    fs.writeFileSync(f.file, elf(true)); f.mapping();
    fs.appendFileSync(path.join(f.proc, 'maps'), '7f002000-7f003000 r-xp 00001000 08:01 42 ' + f.file.replace(/\\/g, '/') + '\n');
    assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false);
    f.mapping(); fs.unlinkSync(f.file); assert.equal(await f.probe(), true); assert.equal(f.probe.aaReady(), false);
});
test('AA capability remains stable while a new inspection is pending and publishes its completed result atomically', async t => {
    let now = 0;
    const f = fixture(t, true, { now: () => now, maxAgeMs: 1000 }), original = f.io.readFile;
    assert.equal(await f.probe(), true); assert(f.probe.aaReady());
    let resume, held;
    const started = new Promise(resolve => { held = resolve; });
    f.io.readFile = function () { const args = arguments; resume = () => original.apply(this, args); held(); };
    const checking = f.probe(); await started;
    assert(f.probe.aaReady(), 'starting a poll must not disable AA');
    assert.equal(f.probe(), checking, 'only one scan may be in flight');
    f.io.readFile = original; resume(); assert.equal(await checking, true); assert(f.probe.aaReady());
    now = 1000; assert.equal(f.probe.aaReady(), false, 'completed snapshot has a bounded age');
});
test('a stalled inspection expires once and a late positive result cannot restore AA', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const f = fixture(t, true, { timeoutMs: 25 }), original = f.io.readFile;
    assert.equal(await f.probe(), true); let resume, held, reads = 0;
    const started = new Promise(resolve => { held = resolve; });
    f.io.readFile = function () { reads++; const args = arguments; resume = () => original.apply(this, args); held(); };
    const checking = f.probe(); await started; assert(f.probe.aaReady());
    t.mock.timers.tick(25);
    assert.equal(await checking, false); assert.equal(f.probe.aaReady(), false);
    assert.equal(await f.probe(), false); assert.equal(reads, 1, 'timeout cannot accumulate blocked scans');
    const originalStat = f.io.stat;
    const completed = new Promise(resolve => {
        f.io.stat = (file, callback) => originalStat(file, (error, info) => {
            callback(error, info); setImmediate(resolve);
        });
    });
    f.io.readFile = original; resume(); await completed; f.io.stat = originalStat;
    assert.equal(f.probe.aaReady(), false, 'late result was discarded');
    assert.equal(await f.probe(), true); assert(f.probe.aaReady());
});
