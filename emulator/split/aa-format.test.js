'use strict';
const test = require('node:test');
const assert = require('node:assert/strict'), EventEmitter = require('node:events');
const { createFormat, statIdentity } = require('../../native/javi-carlab/aa-format');
const turn = () => new Promise(resolve => setImmediate(resolve));
async function rejects(promise, code) {
    const error = await promise.then(() => null, error => error);
    assert(error, 'expected rejection: ' + code); assert.strictEqual(error.code, code);
}
function fakeClock() {
    let time = 0, next = 0;
    const tasks = new Map();
    const schedule = (fn, ms, period) => { const id = ++next; tasks.set(id, { fn, at: time + ms, period }); return id; };
    return {
        now: () => time, set: value => { time = value; },
        setTimeout: (fn, ms) => schedule(fn, ms, 0), clearTimeout: id => tasks.delete(id),
        setInterval: (fn, ms) => schedule(fn, ms, ms), clearInterval: id => tasks.delete(id),
        async advance(ms) {
            const end = time + ms;
            for (let n = 0; n < 2000; n++) {
                let chosen;
                tasks.forEach((value, id) => { if (value.at <= end && (!chosen || value.at < chosen.value.at)) chosen = { id, value }; });
                if (!chosen) { time = end; await turn(); return; }
                time = Math.max(time, chosen.value.at);
                if (chosen.value.period) chosen.value.at = time + chosen.value.period; else tasks.delete(chosen.id);
                chosen.value.fn(); await turn();
            }
            throw Error('timer loop');
        },
        pending: () => tasks.size
    };
}
function proc(pid, starttime) {
    const fields = ['S'].concat(Array(18).fill('0'), [String(starttime)], Array(25).fill('0'));
    return pid + ' (aapd) ' + fields.join(' ');
}
function fixture(options) {
    options = options || {};
    const clock = fakeClock(), commands = [], errors = [], sockets = [], pathStats = [];
    const state = { phase: options.phase || 'ready', epoch: options.epoch === undefined ? 7 : options.epoch,
        writes: options.writes === undefined ? 1 : options.writes, baseline: options.phase === 'off' ? 0 : 1,
        insets: options.insets || [248, 248, 0, 0], dirty: 0, uncertain: 0, starttime: '100',
        generation: options.generation === undefined ? 1 : options.generation, updateSeq: options.updateSeq || 0, setStartedNs: '0' };
    let client, connected = 0, gets = 0;
    const stat = (file) => {
        const isSocket = /\/control$/.test(file);
        return { uid: file === '/tmp' ? 0 : options.uid === undefined ? 13006 : options.uid, gid: file === '/tmp' ? 0 : 13006,
            mode: file === '/tmp' ? 0o41777 : isSocket ? 0o140600 : 0o40700, dev: 1,
            ino: file === '/tmp' ? 1 : isSocket ? 30 : /\/77-100$/.test(file) ? 20 : 10,
            isSocket: () => isSocket, isDirectory: () => !isSocket };
    };
    const fs = {
        readFile(file, encoding, done) { Promise.resolve().then(() => done(null, proc(77, state.starttime))); },
        lstat(file, done) { pathStats.push(file); Promise.resolve().then(() => done(null, stat(file))); }
    };
    const status = result => ({ v: options.version === undefined ? 3 : options.version,
        marker: options.marker || 'javi-aa-format/1.0.0', rearm: 1, leaseMs: 1000, ackMs: 2000,
        generation: state.generation, updateSeq: state.updateSeq, setStartedNs: state.setStartedNs,
        starttime: options.statusStarttime || '100', result, pid: 77, epoch: state.epoch, phase: state.phase, writes: state.writes,
        baseline: state.baseline, insets: state.insets.slice(), dirty: state.dirty, uncertain: state.uncertain,
        updates: 0, ignored: 0, faults: 0, config: 0, source: 'selected-insets', sourceFlags: 2015, uiFlags: 9, themePresent: 1, theme: 0 });
    function send(result) {
        const socket = sockets[0];
        if (socket && !socket.destroyed) socket.emit('data', Buffer.from(JSON.stringify(status(result)) + '\n'));
    }
    function connect(file) {
        assert.strictEqual(file, '/tmp/bmwlauncher-aa-margins-13006/77-100/control'); connected++;
        const socket = new EventEmitter(); socket.destroyed = false; sockets.push(socket);
        socket.write = (line, callback) => {
            commands.push(line.trim());
            if (!options.hangWrite) Promise.resolve().then(() => callback());
            if (options.silent) return true;
            Promise.resolve().then(() => {
                if (socket.destroyed) return;
                const fields = line.trim().split(' '), kind = fields[0];
                if (kind === 'GET') {
                    gets++;
                    if (options.delayedInitialGets && gets <= 2) {
                        const saved = JSON.stringify(status('ok')) + '\n';
                        clock.setTimeout(() => { if (!socket.destroyed) socket.emit('data', Buffer.from(saved)); }, gets === 1 ? 300 : 250);
                    } else send('ok');
                }
                else if (kind === 'SET') {
                    assert.strictEqual(line, 'SET ' + state.epoch + ' ' + (options.displayHeight === 520 ? 'normal' : 'alto') + '\n');
                    state.phase = 'applying'; state.dirty = 1;
                    state.setStartedNs = options.setStartedNs || '12345678901234567'; send('accepted');
                    if (!options.noActive) clock.setTimeout(() => { if (state.phase === 'applying') {
                        state.phase = 'active'; state.updateSeq++; send('state');
                    } }, 20);
                } else if (kind === 'REARM') {
                    assert.equal(fields.length, 4);
                    if (options.rearmSequenceRace) state.updateSeq++;
                    if (options.rearmRejected || fields[1] !== String(state.epoch) || fields[2] !== String(state.generation) ||
                        fields[3] !== String(state.updateSeq)) { send('rejected'); return; }
                    assert.equal(state.phase, 'done'); assert.equal(state.dirty, 0); assert.equal(state.uncertain, 0);
                    state.phase = 'ready'; state.generation++; state.setStartedNs = '0'; send('accepted');
                } else if (kind === 'LEASE') send('accepted');
                else if (kind === 'RESTORE') {
                    assert.strictEqual(line, 'RESTORE ' + state.epoch + '\n');
                    state.phase = 'restoring'; send('accepted');
                    if (!options.noRestore) clock.setTimeout(() => { state.phase = 'done'; state.dirty = 0; state.updateSeq++; send('state'); }, 100);
                } else throw Error('unexpected command');
            });
            return !options.hangWrite;
        };
        socket.end = text => { commands.push(text.trim()); socket.destroy(); };
        socket.destroy = () => { if (!socket.destroyed) { socket.destroyed = true; Promise.resolve().then(() => socket.emit('close')); } };
        Promise.resolve().then(() => { if (!socket.destroyed) { socket.emit('connect'); send('hello'); } });
        return socket;
    }
    client = createFormat(Object.assign({ fs, connect, getuid: () => 0,
        displayHeight: options.displayHeight === undefined ? 572 : options.displayHeight, onError: code => errors.push(code) }, clock));
    const acquiring = () => { const pending = client.acquire({ pid: 77, starttime: '100' }); pending.catch(() => {}); return pending; };
    async function active() { const pending = acquiring(); await turn(); await clock.advance(options.phase === 'done' ? 270 : 20); return pending; }
    return { client, clock, state, commands, errors, sockets, send, acquiring, active, pathStats, connected: () => connected };
}

test('one SET alto, fresh identity/GET profile, leases and observed done on close', async () => {
    const f = fixture(), identity = await f.active();
    assert.deepStrictEqual(identity, { pid: 77, starttime: '100', epoch: 7, generation: 1 });
    const geometry = await f.client.geometryProfile(identity);
    assert.deepStrictEqual(geometry, { display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580,
        width: 1168, height: 580, setStartedNs: '12345678901234567' });
    assert(Object.isFrozen(geometry));
    await f.clock.advance(1000); assert(f.commands.filter(x => x === 'LEASE 7').length >= 4);
    const closing = f.client.close(); await turn(); await f.clock.advance(100);
    assert.deepStrictEqual(await closing, { ok: true, changed: true, restoration: 'observed', epoch: 7, generation: 1 });
    assert.strictEqual(f.commands.filter(x => /^SET /.test(x)).length, 1);
    assert.strictEqual(f.commands.filter(x => /^RESTORE /.test(x)).length, 1);
    assert.strictEqual(f.commands[f.commands.length - 1], 'CLOSE'); assert.strictEqual(f.clock.pending(), 0);
    assert.deepStrictEqual(f.errors, []);
});

test('cancel before security checks completes never connects or writes', async () => {
    const f = fixture(), pending = f.acquiring(), closing = f.client.close();
    await rejects(pending, 'cancelled'); assert.strictEqual((await closing).restoration, 'not-required');
    await turn(); assert.strictEqual(f.connected(), 0); assert.deepStrictEqual(f.commands, []); assert.strictEqual(f.clock.pending(), 0);
});

test('SET waits for both older GET replies and never treats delayed ready as format loss', async () => {
    const f = fixture({ delayedInitialGets: true }), pending = f.acquiring(); await turn();
    await f.clock.advance(300);
    assert.strictEqual(f.commands.filter(x => x === 'GET').length, 2);
    assert(!f.commands.some(x => /^SET /.test(x)), 'second old GET is still outstanding');
    await f.clock.advance(220); await pending;
    assert.strictEqual(f.commands.filter(x => /^SET /.test(x)).length, 1); assert.deepStrictEqual(f.errors, []);
    const closing = f.client.close(); await turn(); await f.clock.advance(100); await closing;
});

test('cancel while applying sends only its own RESTORE and never resolves a late active', async () => {
    const f = fixture({ noActive: true }), pending = f.acquiring(); await turn();
    assert(f.commands.includes('SET 7 alto'));
    const closing = f.client.close(); await rejects(pending, 'cancelled'); await turn();
    f.state.phase = 'active'; f.send('state'); await f.clock.advance(100);
    assert.strictEqual((await closing).restoration, 'observed');
    await rejects(f.client.geometryProfile({ pid: 77, starttime: '100' }), 'geometry-not-active');
});

test('permissions, observe variant and wrong baseline fail before SET', async () => {
    for (const options of [{ uid: 0 }, { writes: 0 }, { insets: [250, 250, 376, 376] }]) {
        const f = fixture(options), pending = f.acquiring(); await turn();
        const code = options.uid === 0 ? 'private-path-permissions' : options.writes === 0 ? 'bridge-read-only' : 'bridge-baseline';
        await rejects(pending, code); await f.client.close();
        assert(!f.commands.some(x => /^SET /.test(x))); assert.strictEqual(f.clock.pending(), 0);
    }
});

test('an epoch change invalidates format and never restores into the new session', async () => {
    const f = fixture(); await f.active(); f.state.epoch = 8; f.send('state');
    await rejects(f.client.close(), 'restore-unconfirmed');
    assert.deepStrictEqual(f.errors, ['bridge-epoch-changed']);
    assert(!f.commands.some(x => /^(SET|LEASE|RESTORE) 8/.test(x))); assert(f.sockets[0].destroyed);
});

test('EOF invalidates immediately and cannot claim restoration without observing done', async () => {
    const f = fixture(); await f.active(); f.sockets[0].emit('end');
    await rejects(f.client.close(), 'restore-unconfirmed');
    assert.deepStrictEqual(f.errors, ['bridge-eof']); assert(f.sockets[0].destroyed); assert.strictEqual(f.clock.pending(), 0);
});

test('PID reuse detected before profile resolution restores and rejects the profile', async () => {
    const f = fixture(), identity = await f.active(); f.state.starttime = '101';
    await rejects(f.client.geometryProfile(identity), 'process-changed');
    await turn(); await f.clock.advance(100); await f.client.close();
    assert.deepStrictEqual(f.errors, ['process-changed']); assert(f.commands.includes('RESTORE 7'));
});

test('ready wait is bounded to four seconds and accepts no late active update', async () => {
    const f = fixture({ phase: 'waiting-baseline' }), pending = f.acquiring(); await turn();
    await f.clock.advance(4000); await rejects(pending, 'acquire-timeout'); await f.client.close();
    assert(!f.commands.some(x => /^SET /.test(x))); assert.strictEqual(f.clock.pending(), 0);
    const g = fixture({ noActive: true }), acquiring = g.acquiring(); await turn();
    g.clock.set(4000); g.state.phase = 'active'; g.send('state');
    await rejects(acquiring, 'acquire-timeout'); await turn(); await g.clock.advance(100); await g.client.close();
});

test('missing restoration is reported within three seconds, never as success', async () => {
    const f = fixture({ noRestore: true }); await f.active(); const closing = f.client.close(); await turn();
    await f.clock.advance(2999); assert.strictEqual(f.client.state().phase, 'closing');
    await f.clock.advance(1); await rejects(closing, 'restore-unconfirmed'); assert.strictEqual(f.clock.pending(), 0);
});

test('the format remains leased beyond the former trial deadline and stops renewal on close', async () => {
    const f = fixture(); await f.active(); await f.clock.advance(41000); await turn();
    assert.deepStrictEqual(f.errors, []); assert.equal(f.client.state().active, true);
    const before = f.commands.filter(x => /^LEASE /.test(x)).length, closing = f.client.close();
    await turn(); await f.clock.advance(100); await closing;
    assert.strictEqual(f.commands.filter(x => /^LEASE /.test(x)).length, before); assert.strictEqual(f.clock.pending(), 0);
});

test('malformed/oversized input and a blocked socket close with bounded resources', async () => {
    const f = fixture(); await f.active(); f.sockets[0].emit('data', Buffer.alloc(8193, 123));
    await rejects(f.client.close(), 'restore-unconfirmed'); assert.strictEqual(f.clock.pending(), 0);
    const g = fixture({ hangWrite: true, silent: true }), pending = g.acquiring(); await turn(); await g.clock.advance(250);
    await rejects(pending, 'bridge-write-timeout'); await g.client.close(); assert.strictEqual(g.clock.pending(), 0);
});

test('process identity parser refuses dead and foreign processes', async () => {
    assert.deepStrictEqual(statIdentity(77, proc(77, '100')), { pid: 77, starttime: '100' });
    assert.throws(() => statIdentity(78, proc(77, '100')), /process-identity/);
    assert.throws(() => statIdentity(77, proc(77, '100').replace(' S ', ' Z ')), /process-identity/);
    assert.throws(() => statIdentity(77, proc(77, '100').replace('(aapd)', '(other)')), /process-identity/);
});

test('capture identity is checked before connection and SET, not only after acquisition', async () => {
    const f = fixture(); f.state.starttime = '101';
    await rejects(f.acquiring(), 'process-changed'); await f.client.close();
    assert.equal(f.connected(), 0); assert.deepEqual(f.commands, []); assert.equal(f.clock.pending(), 0);
});

test('an owner never acquires twice, including after successful restoration', async () => {
    const f = fixture(); await f.active();
    await rejects(f.acquiring(), 'acquire-once');
    const closing = f.client.close(); await turn(); await f.clock.advance(100); await closing;
    await rejects(f.acquiring(), 'acquire-once');
    assert.equal(f.commands.filter(x => /^SET /.test(x)).length, 1);
});

test('older bridge versions, foreign markers and an unrelated process start are rejected before SET', async () => {
    for (const options of [{ version: 1 }, { version: 2 }, { marker: 'foreign' }, { statusStarttime: '101' }]) {
        const f = fixture(options);
        await rejects(f.acquiring(), 'bridge-status'); await f.client.close();
        assert.equal(f.commands.some(x => /^SET /.test(x)), false); assert.equal(f.clock.pending(), 0);
    }
});

test('the normal panel requests normal margins and reports its exact crop without stretching', async () => {
    const f = fixture({ displayHeight: 520 }), identity = await f.active();
    assert.deepEqual(await f.client.geometryProfile(identity), {
        display: 'MAIN', confirmed: true, x: 312, y: 250, w: 1296, h: 580, width: 1296, height: 580,
        setStartedNs: '12345678901234567'
    });
    assert(f.commands.includes('SET 7 normal'));
    const closing = f.client.close(); await turn(); await f.clock.advance(100); await closing;
    assert.throws(() => fixture({ displayHeight: 560 }), /format-display-height/);
});

test('an existing format owner is refused without another SET or REARM', async () => {
    for (const phase of ['active', 'applying', 'restoring']) {
        const f = fixture({ phase });
        await rejects(f.acquiring(), 'format-epoch-busy');
        await f.client.close(); assert.equal(f.commands.some(x => /^(SET|REARM) /.test(x)), false);
    }
});

test('a fresh owner can wait for a new native session baseline and acquire only that epoch', async () => {
    const f = fixture({ epoch: 9, phase: 'waiting-baseline' }), pending = f.acquiring(); await turn();
    assert.equal(f.commands.some(x => /^SET /.test(x)), false);
    f.state.phase = 'ready'; await f.clock.advance(270);
    const identity = await pending; assert.equal(identity.epoch, 9);
    assert(f.commands.includes('SET 9 alto')); assert.equal((await f.client.geometryProfile(identity)).w, 1168);
    const closing = f.client.close(); await turn(); await f.clock.advance(100); await closing;
    assert(f.commands.includes('RESTORE 9'));
});

test('AA underlay can be visible before aapd begins MAIN and publishes its baseline', async () => {
    const f = fixture({ phase: 'off', epoch: 0, generation: 0, insets: [0, 0, 0, 0] });
    const pending = f.acquiring(); await turn(); await f.clock.advance(300);
    assert.deepEqual(f.errors, []);
    assert(f.commands.length >= 2 && f.commands.every(command => command === 'GET'));
    Object.assign(f.state, { phase: 'waiting-baseline', epoch: 1, generation: 1 });
    f.send('state'); await f.clock.advance(250);
    assert(f.commands.every(command => command === 'GET'));
    Object.assign(f.state, { phase: 'ready', baseline: 1, insets: [248, 248, 0, 0] });
    await f.clock.advance(270);
    assert.equal((await pending).epoch, 1);
    assert.equal(f.commands.filter(command => command === 'SET 1 alto').length, 1);
    const closing = f.client.close(); await turn(); await f.clock.advance(100); await closing;
    assert(f.commands.includes('RESTORE 1'));
});

test('cancelling a SET waiting behind older GET replies prevents every mutation', async () => {
    const f = fixture({ delayedInitialGets: true }), pending = f.acquiring(); await turn();
    await f.clock.advance(300); assert.equal(f.commands.filter(x => x === 'GET').length, 2);
    const closing = f.client.close(); await rejects(pending, 'cancelled');
    assert.equal((await closing).restoration, 'not-required'); await f.clock.advance(300);
    assert.equal(f.commands.some(x => /^(SET|RESTORE) /.test(x)), false);
    assert.equal(f.client.state().active, false); assert.equal(f.clock.pending(), 0);
});

test('a new connection rearms only a clean observed generation, then obtains fresh ready before SET', async () => {
    const f = fixture({ phase: 'done', generation: 5, updateSeq: 12 }), identity = await f.active();
    assert.equal(identity.generation, 6);
    assert.deepEqual(f.commands.slice(0, 4), ['GET', 'REARM 7 5 12', 'GET', 'SET 7 alto']);
    assert.equal((await f.client.geometryProfile(identity)).setStartedNs, '12345678901234567');
    const closing = f.client.close(); await turn(); await f.clock.advance(100);
    assert.equal((await closing).generation, 6);
    assert.equal(f.commands.filter(value => /^REARM /.test(value)).length, 1);
});

test('REARM rejection or an intervening update fails without SET or hidden retries', async () => {
    for (const setting of [{ rearmRejected: true }, { rearmSequenceRace: true }]) {
        const f = fixture(Object.assign({ phase: 'done', generation: 3, updateSeq: 10 }, setting));
        await rejects(f.acquiring(), 'bridge-rearm-rejected'); await f.client.close();
        assert.equal(f.commands.filter(value => /^REARM /.test(value)).length, 1);
        assert.equal(f.commands.some(value => /^(SET|RESTORE) /.test(value)), false);
        assert.equal(f.clock.pending(), 0);
    }
});

test('REARM waits for delayed older GET replies before the generation can change', async () => {
    const f = fixture({ phase: 'done', generation: 3, updateSeq: 10, delayedInitialGets: true });
    const pending = f.acquiring(); await turn(); await f.clock.advance(300);
    assert.equal(f.commands.filter(value => value === 'GET').length, 2);
    assert.equal(f.commands.some(value => /^REARM /.test(value)), false);
    await f.clock.advance(500); assert.equal((await pending).generation, 4);
    assert.deepEqual(f.commands.slice(0, 5), ['GET', 'GET', 'REARM 7 3 10', 'GET', 'SET 7 alto']);
    const closing = f.client.close(); await turn(); await f.clock.advance(100); await closing;
});

test('closing after REARM acceptance but before SET leaves no format to restore', async () => {
    const f = fixture({ phase: 'done' }), pending = f.acquiring(); await turn();
    assert(f.commands.includes('REARM 7 1 0')); assert.equal(f.state.generation, 2);
    const closing = f.client.close(); await rejects(pending, 'cancelled');
    assert.equal((await closing).restoration, 'not-required'); await f.clock.advance(500);
    assert.equal(f.commands.some(value => /^(SET|RESTORE) /.test(value)), false); assert.equal(f.clock.pending(), 0);
});

test('unexpected generation, update rollback and setter-boundary changes invalidate the owner', async () => {
    for (const change of [s => { s.generation++; }, s => { s.updateSeq = 0; }, s => { s.setStartedNs = '12345678901234568'; }]) {
        const f = fixture(); await f.active(); change(f.state); f.send('state');
        await rejects(f.client.close(), 'restore-unconfirmed');
        assert.equal(f.errors.length, 1); assert.equal(f.client.state().active, false); assert.equal(f.clock.pending(), 0);
    }
});

test('active without a real setter timestamp cannot resolve geometry and triggers restoration', async () => {
    const f = fixture({ noActive: true }), pending = f.acquiring(); await turn();
    f.state.phase = 'active'; f.state.setStartedNs = '0'; f.state.updateSeq++; f.send('state');
    await rejects(pending, 'bridge-boundary-missing'); await turn(); await f.clock.advance(100); await f.client.close();
    assert(f.commands.includes('RESTORE 7')); assert.equal(f.client.state().active, false);
});

test('real integration, format client and worker preserve SET boundary through IPC and restore before releasing underlay', async t => {
    const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
    const { PassThrough } = require('node:stream');
    const { createIntegration } = require('../../native/javi-carlab/aa-integration');
    const { createPlayer } = require('../../native/javi-carlab/aa-player');
    const bridge = fixture({ phase: 'done', generation: 2, updateSeq: 4, setStartedNs: '1000000000' });
    const natives = [], workers = [], registrations = [], lifecycle = [], pictures = [];
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    function native(file, args) {
        const c = new EventEmitter(); c.file = file; c.args = args; c.exitCode = null;
        c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.writes = [];
        let closed = false;
        function end() {
            if (closed) return; closed = true;
            Promise.resolve().then(() => {
                if (file === 'capture') c.stderr.write('{"type":"closed","code":"complete"}\n');
                c.stdout.end(); c.stderr.end(); c.exitCode = 0; c.emit('exit', 0, null); c.emit('close', 0, null);
            });
        }
        c.stdin = new EventEmitter(); c.stdin.destroyed = false;
        c.stdin.write = value => { c.writes.push(Buffer.from(value)); return true; };
        c.stdin.end = value => { if (value) c.writes.push(Buffer.from(value)); c.stdin.destroyed = true; end(); };
        c.kill = end; natives.push(c);
        if (file === 'capture') Promise.resolve().then(() => c.stderr.write('{"type":"armed"}\n'));
        return c;
    }
    function forkWorker() {
        const c = new EventEmitter(), p = new EventEmitter();
        c.stderr = new PassThrough(); c.exitCode = null; c.connected = p.connected = true; c.messages = [];
        p.hrtime = process.hrtime.bind(process);
        p.exit = code => {
            if (!c.connected) return;
            c.connected = p.connected = false; c.exitCode = code; lifecycle.push('worker-close');
            c.emit('exit', code); c.emit('close', code);
        };
        p.send = (message, callback) => Promise.resolve().then(() => { c.emit('message', message); if (callback) callback(); });
        c.send = (message, callback) => {
            c.messages.push(message);
            Promise.resolve().then(() => { p.emit('message', message); if (callback) callback(); });
        };
        c.kill = () => p.exit(137);
        const file = path.resolve(__dirname, '../../native/javi-carlab/aa-worker.js');
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
            process: p, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
            require(name) {
                assert.equal(name, './aa-player');
                return { createPlayer: (options, send) => createPlayer(Object.assign({}, options, {
                    spawnProcess: native,
                    createRing: () => ({ file: '/dev/shm/mgu-video-bmwlauncher-feedabcd12345678',
                        push: pixels => pictures.push(Buffer.from(pixels)), close() { lifecycle.push('ring-close'); } })
                }), send) };
            }
        }, { filename: file });
        workers.push(c); return c;
    }
    let visible = false;
    const api = createIntegration({ video: (id, file) => registrations.push(file) }, {
        capture: 'capture', ffmpeg: 'decoder', forkProcess: forkWorker, now: bridge.clock.now,
        inspect: async () => ({ pid: 77, starttime: '100', profile: 'mgu21-aa-20261115' }),
        createFormat: () => bridge.client,
        createFocus(applet, changed) {
            Promise.resolve().then(() => changed({ state: 'ready' }));
            return { stop() {
                assert.equal(bridge.client.state().phase, 'closed');
                assert(bridge.commands.includes('RESTORE 7')); assert.equal(workers[0].exitCode, 0);
                lifecycle.push('underlay-release'); return Promise.resolve();
            } };
        },
        input: { setVisible: value => { visible = value; }, ready: () => visible, close: () => Promise.resolve(), setFocus() {} }
    });
    t.after(async () => { const closing = api.close(); await turn(); await bridge.clock.advance(100); await closing; });
    api.context({ state: 1, applet: 1000 }, 1000); api.ready({ video: true }); api.setVisible(true); await turn();
    assert.equal(natives.length, 1); assert.equal(natives[0].file, 'capture');
    await bridge.clock.advance(250); assert.equal(bridge.state.phase, 'applying');
    const keyframe = Buffer.from('000000016742001ff403c0113f2a0000000168aa000000016580', 'hex');
    function frame(data, ns) {
        const header = Buffer.alloc(64); header.writeUInt32LE(0x31464141, 0); header.writeUInt32LE(64, 4);
        header.writeUInt32LE(ns >>> 0, 8); header.writeUInt32LE(Math.floor(ns / 4294967296), 12);
        header.writeUInt32LE(0x31, 24); header.writeUInt32LE(data.length, 32); header.writeUInt32LE(data.length, 36);
        header.writeUInt32LE(77, 48); return Buffer.concat([header, data]);
    }
    natives[0].stdout.write(frame(keyframe, 900000000)); await delay(55);
    assert.equal(natives.length, 1, 'old-layout frames cannot allocate a decoder before configuration');
    const afterSet = Buffer.from(keyframe); afterSet[afterSet.length - 1] = 0x81;
    natives[0].stdout.write(frame(afterSet, 1000000000)); await delay(55);
    await bridge.clock.advance(20); await turn();
    assert.deepEqual(bridge.commands.slice(0, 4), ['GET', 'REARM 7 2 4', 'GET', 'SET 7 alto']);
    const configure = workers[0].messages.find(message => message.type === 'configure');
    assert.equal(configure.profile.setStartedNs, '1000000000');
    const decoder = natives.find(value => value.file === 'decoder'); assert(decoder);
    const encoded = Buffer.concat(decoder.writes);
    assert.equal(encoded.includes(Buffer.from('000000016580', 'hex')), false);
    assert(encoded.includes(Buffer.from('000000016581', 'hex')), 'IDR during negotiation must survive configure');
    assert.equal(api.status().inputReady, false);
    decoder.stdout.write(Buffer.alloc(1168 * 580 * 3 / 2, 81)); await turn();
    assert.equal(api.status().state, 'playing'); assert.equal(api.status().inputReady, true);
    assert.equal(api.frame().geometry.w, 1168); assert.equal(pictures.length, 1);
    const closing = api.close(); await turn(); assert.equal(visible, false);
    assert.equal(lifecycle.includes('underlay-release'), false);
    await bridge.clock.advance(100); await closing;
    assert(lifecycle.indexOf('worker-close') < lifecycle.indexOf('underlay-release'));
    assert.equal(registrations[registrations.length - 1], null);
});
