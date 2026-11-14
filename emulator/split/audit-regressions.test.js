'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { createData } = require('../../native/javi-carlab/drivehub-data');
const createSession = require('../../native/javi-carlab/drivehub-session');
const { createAssistant } = require('../../native/javi-carlab/assistant');
const { createConfig } = require('../../native/javi-carlab/assistant-config');
const { createAudio } = require('../../native/javi-carlab/assistant-audio');
const { createCommands } = require('../../native/javi-carlab/assistant-drivehub');
const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
const { createTdt } = require('../../native/javi-carlab/tdtworld');
const { createRadioUI } = require('../../native/javi-carlab/radio-ui');
const panel = require('../../native/javi-carlab/assistant-panel');
const fakeKey = 'fixture_not_a_real_provider_credential';

test('covered renderer ignores its CCU copy and resumes the same card', async (t) => {
    const gpu = new EventEmitter(); let last;
    const { Canvas } = require('../../native/javi-carlab/vendor/kit_canvas');
    const { play } = require('../../native/javi-carlab/vendor/kit_record');
    const canvas = new Canvas(1960, 520);
    Object.assign(gpu, { place() {}, claim() {}, show() {}, close() {}, grab() {}, frame(cv) { play(cv.words(), canvas); last = Buffer.from(canvas.d); } });
    const s = createSession(gpu, { area: () => ({ scale: 1 }), fixture: { news: [] } });
    t.after(() => s.close()); gpu.emit('ready', {}, { controller: true, touch: true }); s.show(true);
    gpu.emit('state', { onScreen: true }); await delay(50); const before = last;
    gpu.emit('state', { onScreen: false });
    for (let knob = 100; knob < 105; knob++) gpu.emit('ccu', { knob, press: 0, tilt: 0 });
    await delay(260); gpu.emit('state', { onScreen: true }); await delay(45);
    for (let y = 0; y < 520; y++) {
        const start = (y * 1960 + 1050) * 4, end = (y + 1) * 1960 * 4;
        assert.equal(Buffer.compare(last.subarray(start, end), before.subarray(start, end)), 0, 'DriveHub row ' + y);
    }
});

test('a hidden news photo is cancelled before decoding and the same URL is retried on return', async (t) => {
    const jobs = [], data = createData({ photo(url, get, w, h, stretch, current) {
        return new Promise((resolve, reject) => jobs.push({ current, resolve, reject }));
    } }, () => {});
    t.after(() => data.close()); data.showPhoto('https://example.test/news.png');
    assert(jobs[0].current()); data.suspend(); assert.equal(jobs[0].current(), false);
    data.showPhoto('https://example.test/news.png'); assert.equal(jobs.length, 2);
    jobs[0].reject(new Error('cancelled')); await delay(0); assert(jobs[1].current());
    data.close(); assert.equal(jobs[1].current(), false); jobs[1].reject(new Error('closed'));
});

test('key save keeps the masked draft on failure and closes only after successful persistence', async () => {
    let finish, changes = 0;
    const ui = { state: { panel: 'assistant-edit', stack: [{}], assistantEditor: { kind: 'key', draft: fakeKey } },
        assistant: { state: { message: 'No se pudo guardar' }, configure: () => new Promise((resolve) => { finish = resolve; }) } };
    const action = () => panel.action(ui, 'assistant:save', () => {}, () => changes++);
    action(); assert.equal(ui.state.panel, 'assistant-edit'); assert.equal(ui.state.assistantEditor.draft, fakeKey);
    finish(false); await delay(0); assert.equal(ui.state.assistantEditor.draft, fakeKey); assert(ui.state.assistantEditor.error);
    action(); finish(true); await delay(0); assert.equal(ui.state.panel, 'assistant-settings'); assert.equal(ui.state.assistantEditor, null); assert(changes >= 2);
});

test('closing a pending editor cannot reopen it, and rejected text submission preserves the draft', async () => {
    let finish;
    const ui = { state: { panel: 'assistant-edit', stack: [{}], assistantEditor: { kind: 'key', draft: fakeKey } },
        assistant: { state: {}, configure: () => new Promise((resolve) => { finish = resolve; }), submit: () => false } };
    panel.action(ui, 'assistant:save', () => {}); ui.state.assistantEditor = null; ui.state.panel = 'none';
    finish(true); await delay(0); assert.equal(ui.state.panel, 'none');
    ui.state.panel = 'assistant-edit'; ui.state.assistantEditor = { kind: 'text', draft: 'Pon la radio' };
    panel.action(ui, 'assistant:save', () => {}); assert.equal(ui.state.assistantEditor.draft, 'Pon la radio');
});

test('invalid incomplete keys never reach storage and are not discarded', () => {
    const ui = { state: { assistantEditor: { kind: 'key', draft: 'short' } }, assistant: { state: {}, configure() { assert.fail('invalid key persisted'); } } };
    panel.action(ui, 'assistant:save', () => {}); assert.equal(ui.state.assistantEditor.draft, 'short'); assert(ui.state.assistantEditor.error);
});
test('a successful background key save preserves a later sidebar navigation', async () => {
    let finish;
    const ui = createNavigationUI({}, () => {});
    ui.assistant = { state: { config: { provider: 'openai' } }, configure: () => new Promise((resolve) => { finish = resolve; }) };
    ui.activate('assistant:key'); ui.state.assistantEditor.draft = fakeKey; ui.activate('assistant:save');
    ui.activate('settings'); finish(true); await delay(0);
    assert.equal(ui.state.panel, 'settings'); assert.equal(ui.state.assistantEditor, null);
    assert(!ui.state.stack.some((entry) => entry.panel === 'assistant-edit')); ui.close();
});

async function voiceRig(t) {
    const config = createConfig(); await config.ready; await config.update({ key: fakeKey });
    let receive, emit, audioInstances = 0;
    const a = createAssistant({ config, assistantAudio: { capture: {} },
        assistantConnect(c, cb) { receive = cb; return { send() {}, close() {} }; },
        assistantAudioFactory(o, cb) { audioInstances++; emit = cb; return { listen() {}, pcm() {}, finish() {}, close() {} }; }
    }, async () => ({}));
    await a.ready; t.after(() => a.close()); a.setVisible(true); a.listen(); receive({ type: 'ready' });
    return { a, emit, receive, audioInstances: () => audioInstances };
}
test('audio-worker failure releases listening and permits a new text request', async (t) => {
    const { a, emit } = await voiceRig(t);
    emit({ type: 'audio-error', message: 'Audio no disponible' }); assert.equal(a.state.busy, false);
    assert(a.submit('Muéstrame el tiempo'));
    emit({ type: 'capture-end', samples: 10000 }); assert.equal(a.state.status, 'connecting');
});
test('losing the audio output preserves the pending text response', async (t) => {
    const { a, emit, receive } = await voiceRig(t);
    emit({ type: 'capture-end', samples: 24000 });
    emit({ type: 'audio-error', message: 'Salida no disponible' });
    assert.equal(a.state.status, 'thinking'); assert(a.state.busy);
    receive({ type: 'text', text: 'Estos son los datos del coche' }); receive({ type: 'turn' });
    assert.equal(a.state.answer, 'Estos son los datos del coche'); assert.equal(a.state.busy, false);
});
test('a failed voice output cannot respawn per fragment and is retried only for a new request', async (t) => {
    const r = await voiceRig(t); r.emit({ type: 'capture-end', samples: 24000 });
    r.emit({ type: 'audio-error', message: 'Salida no disponible' });
    for (let i = 0; i < 20; i++) r.receive({ type: 'audio', data: 'AAAA' });
    assert.equal(r.audioInstances(), 1); r.receive({ type: 'turn' });
    assert(r.a.submit('Otra petición')); r.receive({ type: 'audio', data: 'AAAA' }); assert.equal(r.audioInstances(), 2);
});
test('the listening owner times out even when the capture child never responds', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const next = await voiceRig(t); t.mock.timers.tick(35001);
    assert.equal(next.a.state.busy, false); assert.equal(next.a.state.status, 'error');
});

test('microphone chunks preserve PCM across IPC bounds and odd-byte splits', () => {
    const events = [], peer = new EventEmitter(); peer.stdout = new PassThrough(); peer.exitCode = 0; peer.kill = () => {};
    const audio = createAudio({ capture: { command: 'fixture', args: [] } }, (e) => events.push(e), { spawn: () => peer });
    audio.listen(); const pcm = Buffer.alloc(65536, 7); peer.stdout.write(pcm.subarray(0, 65535)); peer.stdout.write(pcm.subarray(65535)); audio.listen(); audio.close();
    const frames = events.filter((e) => e.type === 'capture');
    assert(frames.every((e) => e.data.length <= 64000 && Buffer.from(e.data, 'base64').length % 2 === 0));
    assert.deepEqual(Buffer.concat(frames.map((e) => Buffer.from(e.data, 'base64'))), pcm);
    assert.equal(events.find((e) => e.type === 'capture-end').samples, pcm.length / 2);
});

test('TV commands lazily load a cached catalogue before first visit, and offline is not not_found', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-audit-tdt-'));
    const channel = { id: 'la1', name: 'La 1', group: 'Generalistas', sources: ['https://example.test/live.m3u8'] };
    fs.writeFileSync(path.join(dir, 'tdt-es-channels.json'), JSON.stringify([channel]));
    const tdt = createTdt({ tdtDirectory: dir, get: async () => { throw new Error('offline'); } }, () => {});
    t.after(() => { tdt.close(); fs.rmSync(dir, { recursive: true }); });
    const cards = [], commands = createCommands({ tdt, panel: { selectCard: (i) => cards.push(i) } });
    assert.equal(tdt.state.channels.length, 0);
    assert.equal((await commands('list_tv_channels', {}, () => true)).channels[0], 'La 1'); assert.equal(cards.length, 0);
    assert.equal((await commands('play_tv_channel', { channel: 'La 1' }, () => true)).status, 'requested'); assert.deepEqual(cards, [4]);
    const offline = createTdt({ get: async () => { throw new Error('offline'); } }, () => {}); t.after(() => offline.close());
    const query = createCommands({ tdt: offline }); assert.equal((await query('list_tv_channels', {}, () => true)).status, 'unavailable');
});
test('TV catalogue waiting is cancelled on close without dispatching playback', async () => {
    const tdt = createTdt({ get: () => new Promise(() => {}) }, () => {});
    const commands = createCommands({ tdt, panel: { selectCard() { assert.fail('late playback'); } } });
    const wait = commands('play_tv_channel', { channel: 'La 1' }, () => true); tdt.close();
    assert.equal((await wait).status, 'cancelled');
});
test('a stalled TV catalogue returns loading within a bounded deadline', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
    const tdt = createTdt({ get: () => new Promise(() => {}) }, () => {}); t.after(() => tdt.close());
    const pending = tdt.prepareChannels(() => true); t.mock.timers.tick(12100);
    assert.equal(await pending, 'loading');
});
test('retrying an offline TV catalogue waits for the new response', async (t) => {
    let now = 10000, retry = false, release;
    const tdt = createTdt({ now: () => now, get: () => retry ? new Promise((resolve) => { release = resolve; }) : Promise.reject(new Error('offline')) }, () => {});
    t.after(() => tdt.close()); assert.equal(await tdt.prepareChannels(() => true), 'unavailable');
    now += 61000; retry = true; let completed = false;
    const result = tdt.prepareChannels(() => true).then((status) => { completed = true; return status; });
    await delay(20); assert.equal(completed, false); assert.equal(tdt.state.status, 'loading');
    release(Buffer.from(JSON.stringify({ countries: [{ ambits: [{ name: 'Generalistas', channels: [{ name: 'La 1', epg_id: 'La1.TV', options: [{ format: 'm3u8', url: 'https://example.test/live.m3u8' }] }] }] }] })));
    assert.equal(await result, 'ready');
});

test('radio cache invalidates on native lists, local overrides, external filters and expiration', () => {
    const ui = createRadioUI({});
    const s = (id, list) => ({ key: '' + id, memoryKey: 'm' + id, id, position: 0, name: 'Radio ' + id, title: '', artist: '', band: 'DAB', frequency: null,
        list, category: 'music', favorite: false, receptionLost: false, programme: null });
    const f = (stations) => ({ version: 1, stations, current: null, active: false, sourceKnown: true, listError: '', logo: null, artwork: null, result: null });
    ui.receive(f([s(1, 2), s(1, 7), s(2, 2)]), 10000); ui.state.filters = ['favorites'];
    assert.deepEqual(ui.rows().map((s) => s.id), [1]); ui.toggleFavorite(ui.rows()[0]); assert.equal(ui.rows().length, 0);
    ui.state.filters = []; assert.equal(ui.rows().length, 2);
    ui.receive(f([s(3, 7)]), 10001); ui.state.filters = ['favorites']; assert.deepEqual(ui.rows().map((s) => s.id), [3]);
    ui.update(15002, false); assert.equal(ui.rows().length, 0); ui.close();
});

test('stable navigation geometry preserves manual camera while new route, location and stops reframe', () => {
    const ui = createNavigationUI({}, () => {}); const a = { latitude: 40, longitude: -3 }, b = { latitude: 41, longitude: -4 };
    const nav = { state: 'active', points: [a, b], route: { key: '1:1' }, destinations: [], segments: [],
        controls: { request: 0, busy: false, status: 'preview', plan: { key: '1:1' }, stops: [] } };
    ui.state.panel = 'route'; ui.update(nav, { location: a }, true); ui.state.camera.zoom = 18;
    ui.update(Object.assign({}, nav), { location: Object.assign({}, a) }, true); assert.equal(ui.state.camera.zoom, 18);
    nav.points = [a, { latitude: 42, longitude: -2 }]; ui.update(nav, { location: a }, true); assert(ui.state.camera.zoom < 18);
    ui.state.camera.zoom = 18; nav.controls.stops = [{ latitude: 43, longitude: -1 }]; ui.update(nav, { location: a }, true); assert(ui.state.camera.zoom < 18);
    ui.state.camera.zoom = 18; ui.update(nav, { location: b }, true); assert(ui.state.camera.zoom < 18); ui.close();
});
