'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createAudio, samplePath } = require('../../apps/javi_carlauncher/audio-bmw');
const { createBridge, consume } = require('../../native/javi-carlab/tdt-bmw-bridge');
const { createSamplePlayer } = require('../../native/javi-carlab/tdt-bmw-sample');
const { createTdt } = require('../../native/javi-carlab/tdtworld');
const id = 'a123456789abcdef';
async function until(fn) {
    const end = Date.now() + 3000;
    while (!fn()) { if (Date.now() > end) throw new Error('timeout'); await delay(10); }
}
function audioFixture(t, configure) {
    const calls = [], events = [], connections = [];
    let state = 2, file = '', elapsed = 0;
    const cc = {
        getListMainSources: async () => ({ amError: 0, listMainSources: [{ sourceID: 1046, name: 'OAPGenericMedia' }] }),
        getListMainSinks: async () => ({ amError: 0, listMainSinks: [{ sinkID: 1024, name: 'MediaSink_Front' }] }),
        getListMainConnections: async () => ({ amError: 0, listConnections: connections }),
        async connect(args) { calls.push(['connect', args]); connections.push({ mainConnectionID: 7, sourceID: 1046, sinkID: 1024 }); return { amError: 0, mainConnectionID: 7 }; },
        async disconnect(args) { calls.push(['disconnect', args]); connections.length = 0; return { amError: 0 }; }, dispose() {}
    };
    const mp = {
        playerState: { getValue: async () => state },
        currentItemTime: { getValue: async () => ({ elapsed: elapsed += 400, total: 30000 }) },
        currentItemPath: { getValue: async () => [{ name: file }] },
        async playFile(args) { calls.push(['play', args]); file = args.path; state = 1; return { EntError: 0 }; },
        async sendButtonEvent(args) { calls.push(['button', args]); return { EntError: 0 }; }, dispose() {}
    };
    if (configure) configure({ cc, mp, connections, calls });
    const audio = createAudio({ buildAndInitTypedProxy: async (name, instance) => {
        calls.push(['proxy', name, instance]); return name.endsWith('CommandControl') ? cc : mp;
    } }, (e) => events.push(e));
    t.after(() => audio.close());
    return { audio, calls, events, cc, mp, connections };
}
function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-native-test-'));
    t.after(() => { assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }); });
    return dir;
}

test('native BMW playback uses only the named media route and releases its exact connection', async (t) => {
    const { audio, calls, events } = audioFixture(t);
    assert.equal(audio.command({ op: 'play', id, path: '/etc/passwd' }), false);
    assert(audio.command({ op: 'play', id, path: samplePath(id) }));
    await until(() => events.some((e) => e.state === 'playing'));
    assert.deepEqual(calls.find((c) => c[0] === 'connect')[1], { sourceID: 1046, sinkID: 1024 });
    assert.equal(calls.find((c) => c[0] === 'play')[1].path, samplePath(id));
    await audio.close();
    assert.deepEqual(calls.find((c) => c[0] === 'button')[1], { button: 2, action: 0 });
    assert.deepEqual(calls.filter((c) => c[0] === 'disconnect'), [['disconnect', { mainConnectionID: 7 }]]);
});

test('foreign source ownership and E_ALREADY_EXISTS never trigger playback, STOP or disconnect', async (t) => {
    for (const race of [false, true]) {
        const { audio, events, calls } = audioFixture(t, ({ cc, connections }) => {
            if (race) cc.connect = async () => ({ amError: 5, mainConnectionID: 99 });
            else connections.push({ sourceID: 1046, sinkID: 1024, mainConnectionID: 99 });
        });
        audio.command({ op: 'play', id, path: samplePath(id) });
        await until(() => events.some((e) => e.state === 'error'));
        await audio.close();
        assert.equal(calls.some((c) => ['play', 'button', 'disconnect'].includes(c[0])), false);
    }
});

test('cancelling during connect cleans up a late owned connection without playing the file', async (t) => {
    let resolve, reached = false;
    const f = audioFixture(t, ({ cc, connections }) => { cc.connect = () => { reached = true; return new Promise((r) => { resolve = () => { connections.push({ mainConnectionID: 7, sourceID: 1046, sinkID: 1024 }); r({ amError: 0, mainConnectionID: 7 }); }; }); }; });
    f.audio.command({ op: 'play', id, path: samplePath(id) }); await until(() => reached);
    const closing = f.audio.close(); resolve(); await closing;
    assert.equal(f.calls.some((c) => c[0] === 'play' || c[0] === 'button'), false);
    assert.equal(f.calls.filter((c) => c[0] === 'disconnect').length, 1);
});

test('a rejected WAV preserves the BMW result and releases only the owned route', async (t) => {
    const f = audioFixture(t, ({ mp }) => { mp.playFile = async () => ({ EntError: 'NOT_SUPPORTED' }); });
    f.audio.command({ op: 'play', id, path: samplePath(id) });
    await until(() => f.events.some((e) => e.state === 'error'));
    await f.audio.close();
    assert.equal(f.events.find((e) => e.state === 'error').result, 'NOT_SUPPORTED');
    assert.equal(f.calls.some((c) => c[0] === 'button'), false);
    assert.equal(f.calls.filter((c) => c[0] === 'disconnect').length, 1);
});

test('an unavailable BMW player after connect releases the owned route and does not report E_OK as the error', async (t) => {
    const f = audioFixture(t), events = [];
    const audio = createAudio({ async buildAndInitTypedProxy(name) {
        if (name.endsWith('CommandControl')) return f.cc;
        throw new Error('service-unavailable');
    } }, (value) => events.push(value));
    t.after(() => audio.close());
    audio.command({ op: 'play', id, path: samplePath(id) });
    await until(() => events.some((e) => e.state === 'error')); await audio.close();
    assert.equal(events.find((e) => e.state === 'error').code, 'service');
    assert.equal(events.find((e) => e.state === 'error').result, undefined);
    assert.equal(f.calls.filter((c) => c[0] === 'disconnect').length, 1);
    assert.equal(f.calls.some((c) => c[0] === 'button' || c[0] === 'play'), false);
});

test('the bounded audio bridge rejects old clocks and cancels when the OAP peer disappears', () => {
    const sent = [], received = [], b = createBridge((message) => { sent.push(JSON.parse(message)); return true; });
    b.receive({ state: 'ready' }); b.start(id, samplePath(id), (e) => received.push(e));
    b.receive({ id: 'b123456789abcdef', state: 'playing', elapsed: 400, total: 30000 });
    b.receive({ id, state: 'playing', elapsed: -1, total: 30000 }); assert.equal(received.length, 0);
    b.receive({ id, state: 'playing', elapsed: 400, total: 30000 }); assert.equal(received.length, 1);
    b.disconnected(); assert.equal(received[1].code, 'bridge');
    assert.equal(sent[sent.length - 1].op, 'stop');
    const read = consume(() => {});
    assert.equal(read(Buffer.alloc(8193)), false);
    assert.equal(consume(() => {})(Buffer.from('not json\n')), false);
});

test('complete WAV and matching video are prepared before BMW opens them; its clock drives the image', async (t) => {
    const directory = temporary(t), states = [], commands = [];
    let ring, child;
    const p = createSamplePlayer({ video(_, file) { ring = file; } }, { directory, sampleSeconds: 1, nativeSend: (c) => commands.push(c),
        spawnProcess() {
            child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
            child.kill = () => {}; child.exitCode = 0;
            return child;
        } });
    t.after(() => p.stop()); p.ready({ video: true }); p.start(['https://example.test/channel.m3u8'], (s, d) => states.push([s, d]));
    await until(() => child);
    const video = Buffer.alloc(20 * 86400); for (let i = 0; i < 20; i++) video.fill(i, i * 86400, (i + 1) * 86400);
    child.stdout.emit('data', video); child.stdio[3].emit('data', Buffer.alloc(192000, 1)); child.emit('close', 0);
    const play = commands.find((c) => c.type === 'native-play'); assert(play);
    const wav = fs.readFileSync(play.path);
    assert.equal(wav.length, 192044); assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.readUInt32LE(40), 192000); assert.equal(wav.readUInt32LE(24), 48000);
    p.nativeStatus({ id: play.id, state: 'paused', elapsed: 500 }); await delay(70);
    const bytes = fs.readFileSync(ring), slot = bytes.readUInt32LE(20);
    assert.equal(bytes[64 + slot * 86400], 10);
    p.stop(); assert.equal(ring, null); assert.deepEqual(fs.readdirSync(directory), []);
    assert(commands.some((c) => c.type === 'native-stop' && c.id === play.id));
});

test('late network setup after cancellation is closed before any decoder is started', async (t) => {
    let resolve, stopped = 0, spawned = 0;
    const p = createSamplePlayer({ video() {} }, { directory: temporary(t), nativeSend() {},
        proxy: () => new Promise((r) => { resolve = r; }), spawnProcess: () => { spawned++; } });
    p.ready({ video: true }); p.start(['https://example.test/live'], () => {}); p.stop();
    resolve({ close() { stopped++; } }); await delay(0);
    assert.equal(spawned, 0); assert.equal(stopped, 1);
});

test('BMW sample mode is selected explicitly and never auto-starts from resume', async (t) => {
    const directory = temporary(t), started = [];
    const channel = { id: 'sample', name: 'Canal', sources: ['https://example.test/live'] };
    const options = { fixture: { tdtChannels: [channel] }, tdtDirectory: directory,
        tdtPlayer: { stop() {}, start(sources, changed, mode) { started.push(mode); changed('playing'); } } };
    const tdt = createTdt(options, () => {}); t.after(() => tdt.close());
    tdt.update(Date.now(), true); tdt.press(true); tdt.rotate(2); tdt.press(false);
    tdt.rotate(1); tdt.press(false); assert.equal(tdt.state.prefs.audioMode, 'bmw-sample');
    tdt.press(true); tdt.press(false); await until(() => started.length);
    assert.deepEqual(started, ['bmw-sample']); tdt.close();
    const restored = createTdt(options, () => {}); t.after(() => restored.close());
    restored.update(Date.now(), true); await delay(20); assert.equal(started.length, 1);
});

test('energy panels hide forecasts without navigation and pack destination after Now without charge stops', () => {
    const { energyPanels } = require('../../native/javi-carlab/drivehub-view');
    const values = ['now', 'stop', 'charged', 'destination'];
    assert.deepEqual(energyPanels(values), ['now']);
    assert.deepEqual(energyPanels(values, { state: 'inactive', destinations: [{ charging: true }] }), ['now']);
    assert.deepEqual(energyPanels(values, { state: 'active', destinations: [] }), ['now', 'destination']);
    assert.deepEqual(energyPanels(values, { state: 'active', destinations: [{ charging: true, final: true }] }), ['now', 'destination']);
    assert.deepEqual(energyPanels(values, { state: 'active', destinations: [{ charging: true, final: false }] }), values);
});
