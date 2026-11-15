'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { createIntegration } = require('../../native/javi-carlab/aa-integration');
const { createPlayer } = require('../../native/javi-carlab/aa-player');
const turn = () => new Promise(resolve => setImmediate(resolve));
const settleFiles = () => new Promise(resolve => setTimeout(resolve, 30));

// Keep the real integration/process/worker/player/ring chain. Only BMW IPC,
// process creation and the decoder output are simulated.
function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-recovery-'));
    const natives = [], registrations = [], workers = [];
    let acquisitions = 0, visible = false, resume, reject;
    const replacement = new Promise((yes, no) => { resume = yes; reject = no; });
    function native(file) {
        const c = new EventEmitter(); c.file = file; c.exitCode = null;
        c.stdout = new PassThrough(); c.stderr = new PassThrough();
        let closed = false;
        function end() {
            if (closed) return; closed = true;
            Promise.resolve().then(() => {
                if (file === 'capture') c.stderr.write('{"type":"closed","code":"complete"}\n');
                c.stdout.end(); c.stderr.end(); c.exitCode = 0;
                c.emit('exit', 0, null); c.emit('close', 0, null);
            });
        }
        c.stdin = new EventEmitter(); c.stdin.destroyed = false;
        c.stdin.write = () => true;
        c.stdin.end = () => { c.stdin.destroyed = true; end(); };
        c.kill = end; natives.push(c);
        if (file === 'capture') Promise.resolve().then(() => c.stderr.write('{"type":"armed"}\n'));
        return c;
    }
    function forkWorker() {
        const c = new EventEmitter(), p = new EventEmitter();
        c.stderr = new PassThrough(); c.connected = p.connected = true;
        p.hrtime = process.hrtime.bind(process);
        p.exit = code => {
            if (!c.connected) return;
            c.connected = p.connected = false;
            c.emit('exit', code); c.emit('close', code);
        };
        p.send = (message, callback) => Promise.resolve().then(() => { c.emit('message', message); if (callback) callback(); });
        c.send = (message, callback) => Promise.resolve().then(() => { p.emit('message', message); if (callback) callback(); });
        c.kill = () => p.exit(137);
        const file = path.resolve(__dirname, '../../native/javi-carlab/aa-worker.js');
        vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
            process: p, Buffer, setTimeout, clearTimeout, setInterval, clearInterval,
            require(name) {
                assert.equal(name, './aa-player');
                return { createPlayer: (options, send) => createPlayer(Object.assign({}, options, { spawnProcess: native }), send) };
            }
        }, { filename: file });
        workers.push(c); return c;
    }
    const api = createIntegration({ video: (id, file) => registrations.push(file) }, {
        directory, capture: 'capture', ffmpeg: 'decoder', forkProcess: forkWorker, now: () => 100,
        inspect: async () => ({ pid: 77, starttime: '100', profile: 'mgu21-aa-20261115' }),
        createFocus(applet, changed) {
            Promise.resolve().then(() => changed({ state: 'ready' }));
            return { stop: async () => {} };
        },
        createFormat() {
            const number = ++acquisitions;
            return {
                acquire: () => number === 1 ? Promise.resolve() : replacement,
                geometryProfile: async () => ({ display: 'MAIN', confirmed: true,
                    x: 376, y: 250, w: 1168, h: 580, setStartedNs: '1000000000' }),
                close: async () => {}
            };
        },
        input: { setVisible: value => { visible = value; }, ready: () => visible, close: async () => {}, setFocus() {} }
    });
    t.after(async () => { await api.close(); await settleFiles(); fs.rmSync(directory, { recursive: true, force: true }); });
    api.context({ state: 1, applet: 1000 }, 1000); api.ready({ video: true }); api.setVisible(true);
    return { api, natives, registrations, directory, workers, resume, reject,
        picture: value => natives.filter(c => c.file === 'decoder').slice(-1)[0].stdout.write(Buffer.alloc(1168 * 580 * 3 / 2, value)) };
}

for (const outcome of ['replace', 'hide', 'reject']) {
    test('AA integration retains the last MGVF frame through capture recovery, then ' + outcome, async t => {
        const f = fixture(t); await turn(); f.picture(81); await turn();
        assert.equal(f.api.status().inputReady, true);
        const frame = f.api.frame(), file = f.registrations[0];
        assert(file); const bytes = fs.readFileSync(file);
        f.natives[0].stderr.write('{"type":"recovery-needed","requiredBytes":130000}\n');
        await turn();
        assert.equal(f.api.status().inputReady, false);
        assert.equal(f.api.touch('down', { x: 1, y: 1 }), false);
        assert.equal(f.api.controller({ type: 'rotate', delta: 1 }), false);
        await turn(); await settleFiles();
        assert.equal(f.workers.length, 2, 'replacement capture starts after old capture closes');
        assert.equal(f.api.frame(), frame);
        assert.deepEqual(f.registrations, [file], 'recovery never unregisters the displayed frame');
        assert.deepEqual(fs.readFileSync(file), bytes, 'ring stays readable after worker exit');
        if (outcome === 'replace') {
            f.resume(); await turn();
            assert.equal(f.api.frame(), frame, 'configuration alone does not replace pixels');
            assert.equal(f.api.status().inputReady, false);
            f.picture(99); await turn(); await settleFiles();
            assert.equal(f.api.status().inputReady, true);
            assert.notEqual(f.api.frame(), frame);
            assert.equal(f.registrations.length, 2); assert(f.registrations[1]);
            assert.equal(fs.existsSync(file), false, 'old file is released only after the new frame');
        } else if (outcome === 'hide') {
            f.api.setVisible(false); f.resume(); await turn();
            assert.equal(f.api.frame(), undefined); assert.equal(f.api.status().inputReady, false);
        } else {
            f.reject(new Error('format-rejected')); await turn();
            assert.equal(f.api.frame(), undefined); assert.equal(f.api.status().detail, 'format-rejected');
        }
        await f.api.close(); await settleFiles();
        assert.equal(f.registrations[f.registrations.length - 1], null);
        assert.deepEqual(fs.readdirSync(f.directory), [], 'no rings survive close, rejection or cancellation');
    });
}
