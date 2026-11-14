'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs/promises');
const os = require('node:os'), path = require('node:path');
const { createConfig } = require('../../native/javi-carlab/assistant-config');
const { createAssistant } = require('../../native/javi-carlab/assistant');
const { createCommands } = require('../../native/javi-carlab/assistant-drivehub');
const { matching, validArguments } = require('../../native/javi-carlab/assistant-tools');
const protocol = require('../../native/javi-carlab/assistant-protocol');
const { start } = require('../../native/javi-carlab/assistant-worker');
const WS = require('../../native/javi-carlab/vendor/ws');
const fakeKey = 'test_credential_not_valid_at_any_provider';
const settle = () => new Promise(setImmediate);
const until = async (condition) => { const deadline = Date.now() + 2000; while (!condition() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5)); assert(condition()); };

test('private credentials survive restart, never occur in snapshots or ciphertext, and concurrent settings preserve keys', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmw-assistant-config-'));
    try {
        const directory = path.join(root, 'private'), config = createConfig(directory); await config.ready;
        await Promise.all([config.update({ key: fakeKey }), config.update({ voice: 'cedar' })]);
        const content = await fs.readFile(path.join(directory, 'settings.enc'));
        assert(!content.includes(Buffer.from(fakeKey))); assert(!JSON.stringify(config.snapshot()).includes(fakeKey));
        const restored = createConfig(directory); await restored.ready;
        assert.equal(restored.credentials().key, fakeKey); assert.equal(restored.snapshot().voices.openai, 'cedar');
        await restored.update({ key: '' }); assert.equal(restored.snapshot().configured.openai, false);
        await assert.rejects(restored.update({ key: 'invalid\nkey' }));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('missing wrapping key or corrupted ciphertext never silently overwrites existing credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmw-assistant-corrupt-'));
    try {
        const config = createConfig(root); await config.ready; await config.update({ key: fakeKey });
        const before = await fs.readFile(path.join(root, 'settings.enc'));
        await fs.unlink(path.join(root, 'device.key'));
        const broken = createConfig(root); await broken.ready; assert(broken.snapshot().error);
        await assert.rejects(broken.update({ key: fakeKey }));
        assert.deepEqual(await fs.readFile(path.join(root, 'settings.enc')), before);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('tool allowlist rejects arbitrary actions and matching preserves ambiguous station names', () => {
    assert(validArguments('set_radio_station', { station: 'Onda Cero' }));
    assert(!validArguments('shell', { command: 'x' }));
    assert(!validArguments('set_radio_station', { station: 'Onda Cero', command: 'x' }));
    assert(!validArguments('set_bmwlauncher_setting', { theme: 'secret' }));
    assert.equal(matching([{ name: 'Radio Nacional' }, { name: 'Radio Nacional Clásica' }], 'radio').length, 2);
    assert.deepEqual(matching([{ name: 'Clásica' }], 'clasica'), [{ name: 'Clásica' }]);
});

test('assistant invalidates queued tool calls and late responses when hidden; reconnection never replays actions', async () => {
    const config = createConfig(); await config.ready; await config.update({ key: fakeKey });
    const connections = [], executed = []; let release;
    const a = createAssistant({ config, assistantConnect(c, receive) { const peer = { config: c, receive, sent: [], closed: false,
        send(m) { this.sent.push(m); return true; }, close() { this.closed = true; } }; connections.push(peer); return peer; } },
        async (name, args) => { executed.push(args.station); if (args.station === 'one') await new Promise((r) => { release = r; }); return { status: 'confirmed' }; });
    await a.ready; a.setVisible(true); assert(a.submit('Pon una emisora')); connections[0].receive({ type: 'ready' });
    connections[0].receive({ type: 'tool', id: '1', name: 'set_radio_station', args: { station: 'one' } });
    connections[0].receive({ type: 'tool', id: '2', name: 'set_radio_station', args: { station: 'two' } });
    await settle(); a.setVisible(false); release(); await settle();
    assert.deepEqual(executed, ['one']); assert(connections[0].closed);
    connections[0].receive({ type: 'text', text: 'late' }); assert.equal(a.state.answer, '');
    a.setVisible(true); a.submit('Nueva petición'); connections[1].receive({ type: 'ready' });
    assert.equal(connections[1].sent.length, 1); assert.equal(connections[1].sent[0].text, 'Nueva petición'); a.close();
});

test('duplicate tool IDs execute once and unknown commands return an error without running', async () => {
    const config = createConfig(); await config.ready; await config.update({ key: fakeKey });
    let receive, calls = 0; const sent = [];
    const a = createAssistant({ config, assistantConnect(c, cb) { receive = cb; return { send: (m) => sent.push(m), close() {} }; } }, async () => { calls++; return { status: 'ok' }; });
    await a.ready; a.setVisible(true); a.submit('Muestra la radio'); receive({ type: 'ready' });
    const event = { type: 'tool', id: 'same', name: 'show_drivehub_card', args: { card: 'radio' } }; receive(event); receive(event);
    receive({ type: 'tool', id: 'wrong', name: 'change_vehicle', args: {} });
    await settle(); assert.equal(calls, 1); assert.equal(sent.filter((m) => m.op === 'result').length, 2); a.close();
});

test('DriveHub tools use native radio, current readings and downloaded news, without changing card to tune', async () => {
    const selected = [], tuned = [], data = { news: [{ title: 'El tiempo en Madrid', summary: 'Texto', url: 'https://example.test/a' }] };
    const commands = createCommands({ panel: { selectCard(i) { selected.push(i); }, setArticleCount() {} },
        radio: { allStations: () => [], playNamed: async (name) => { tuned.push(name); return { status: 'confirmed' }; } },
        tdt: { state: { channels: [] } }, navigation: { state: { theme: 'night' } }, data,
        vehicle: () => ({ soc: 91, batteryTemperature: 19 }), weather: () => undefined });
    assert.equal((await commands('set_radio_station', { station: 'Onda Cero' }, () => true)).status, 'confirmed');
    assert.deepEqual(tuned, ['Onda Cero']); assert.deepEqual(selected, []);
    const result = await commands('get_vehicle_status', {}, () => true); assert.equal(result.readings.soc, 91); assert.equal(result.units.batteryTemperature, '°C');
    assert.equal((await commands('search_drivehub_news', { query: 'Madrid' }, () => true)).status, 'shown'); assert.deepEqual(selected, [3]);
});

test('provider protocols carry voices, text and audio separately, and do not label connection as audible sound', () => {
    const c = { provider: 'openai', voice: 'cedar', audio: true, key: fakeKey };
    assert.equal(protocol.setup(c).session.audio.output.voice, 'cedar');
    assert.deepEqual(protocol.setup(Object.assign({}, c, { audio: false })).session.output_modalities, ['text']);
    assert.equal(protocol.setup({ provider: 'gemini', voice: 'Kore' }).setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
    assert.equal(protocol.events('openai', { type: 'response.function_call_arguments.done', call_id: '1', name: 'x', arguments: '{' })[0].args, null);
    assert.equal(protocol.events('gemini', { toolCall: { functionCalls: [{ id: '2', name: 'get_vehicle_status', args: {} }] } })[0].name, 'get_vehicle_status');
});

test('real WebSocket transport completes OpenAI tool round only after response.done and rejects duplicates', async () => {
    const server = new WS.Server({ port: 0, host: '127.0.0.1' }); await new Promise((r) => server.on('listening', r));
    const messages = [], events = []; let peer;
    server.on('connection', (socket) => { peer = socket; socket.on('message', (b) => messages.push(JSON.parse(String(b)))); });
    class LocalSocket extends WS { constructor(_url, options) { super('ws://127.0.0.1:' + server.address().port, Object.assign({}, options, { headers: {} })); } }
    const session = start({ provider: 'openai', voice: 'marin', key: fakeKey }, (e) => events.push(e), { WebSocket: LocalSocket });
    try {
        await until(() => messages.length === 1); peer.send(JSON.stringify({ type: 'session.updated' })); await until(() => events.length === 1);
        session.text('Pon Onda Cero'); await until(() => messages.length === 3);
        const call = { type: 'response.function_call_arguments.done', call_id: 'a', name: 'set_radio_station', arguments: JSON.stringify({ station: 'Onda Cero' }) };
        peer.send(JSON.stringify(call)); peer.send(JSON.stringify(call)); await until(() => events.some((e) => e.type === 'tool'));
        session.result('a', { status: 'confirmed' }); await until(() => messages.length === 4);
        assert.equal(messages.filter((m) => m.type === 'response.create').length, 1);
        peer.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } })); await until(() => messages.length === 5);
        assert.equal(messages[4].type, 'response.create'); assert.equal(events.filter((e) => e.type === 'tool').length, 1);
        peer.send(JSON.stringify({ type: 'response.output_text.delta', delta: 'Emisora confirmada' }));
        peer.send(JSON.stringify({ type: 'response.done', response: { status: 'completed' } })); await until(() => events.some((e) => e.type === 'turn'));
    } finally { session.close(); if (peer) peer.terminate(); await new Promise((r) => server.close(r)); }
});

test('radio assistant awaits BMW acknowledgement and does not invent station IDs', async () => {
    const { createRadioUI } = require('../../native/javi-carlab/radio-ui');
    const { station } = require('../../apps/javi_carlauncher/radio-datos');
    let command;
    const radio = createRadioUI({ radioCommand(c) { command = c; return true; } });
    const s = station({ dataBaseIdentifier: 12, positionNumber: 0, waveBand: 1, stationLongName: 'Onda Cero', frequencyKhz: 98500, id: 4012, pty: 10, ptyTableType: 0, receptionMode: 0 }, 2);
    const frame = { version: 1, at: Date.now(), available: true, stations: [s], current: null, active: false, sourceKnown: true, loading: false, busy: false, listError: '', result: null, logo: null, artwork: null };
    radio.receive(frame, Date.now());
    let done = false; const job = radio.playNamed('Onda Cero', () => true).then((r) => { done = true; return r; });
    await settle(); assert(command); assert.equal(command.key, s.key); assert.equal(done, false);
    radio.receive(Object.assign({}, frame, { result: { id: command.id, ok: true, message: 'Confirmada' } }), Date.now());
    await settle(); assert.equal(done, false, 'Aceptar la petición no demuestra emisora activa');
    radio.receive(Object.assign({}, frame, { current: s, active: true }), Date.now());
    assert.equal((await job).status, 'confirmed');
    assert.equal((await radio.playNamed('Inventada', () => true)).status, 'not_found'); radio.close();
});

test('settings key editor masks secrets and saving/back never restores its draft', async () => {
    const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
    const { controls } = require('../../native/javi-carlab/navigation-panels');
    const { Recorder } = require('./software-renderer');
    const config = createConfig(), a = createAssistant({ config }, async () => ({})), ui = createNavigationUI({}, () => {});
    await a.ready; ui.assistant = a;
    try {
        ui.activate('settings'); ui.activate('assistant:settings'); ui.activate('assistant:key');
        for (const letter of fakeKey) ui.activate('assistant:char:' + letter);
        assert.equal(ui.state.assistantEditor.draft, fakeKey);
        const cv = new Recorder(1960, 520), labels = []; cv.text = (s) => labels.push(s);
        controls(cv, ui, { theme: 'night', state: 'inactive' });
        assert(!labels.some((s) => s.includes(fakeKey))); assert(labels.includes('********'));
        ui.activate('assistant:save'); await until(() => !a.state.saving);
        assert.equal(ui.state.assistantEditor, null); assert.equal(a.state.config.configured.openai, true);
        ui.activate('back'); assert.notEqual(ui.state.panel, 'assistant-edit');
    } finally { ui.close(); a.close(); }
});

test('Gemini WebSocket setup, transcription and tool responses use the expected wire contract', async () => {
    const server = new WS.Server({ port: 0, host: '127.0.0.1' }); await new Promise((r) => server.on('listening', r));
    let peer; const messages = [], events = [];
    server.on('connection', (s) => { peer = s; s.on('message', (b) => messages.push(JSON.parse(String(b)))); });
    class LocalSocket extends WS { constructor() { super('ws://127.0.0.1:' + server.address().port); } }
    const session = start({ provider: 'gemini', voice: 'Kore', key: fakeKey, audio: true }, (e) => events.push(e), { WebSocket: LocalSocket });
    try {
        await until(() => messages.length === 1); assert.equal(messages[0].setup.model, 'models/gemini-3.8-live');
        peer.send(JSON.stringify({ setupComplete: {} })); await until(() => events.length === 1);
        session.text('Muéstrame el tiempo'); await until(() => messages.length === 2);
        peer.send(JSON.stringify({ toolCall: { functionCalls: [{ id: 'g1', name: 'show_drivehub_card', args: { card: 'weather' } }] } }));
        await until(() => events.some((e) => e.type === 'tool')); session.result('g1', { status: 'shown' });
        await until(() => messages.length === 3); assert.equal(messages[2].toolResponse.functionResponses[0].response.status, 'shown');
        peer.send(JSON.stringify({ serverContent: { outputTranscription: { text: 'Aquí tienes el tiempo.' }, turnComplete: true } }));
        await until(() => events.some((e) => e.type === 'turn')); assert(events.some((e) => e.text === 'Aquí tienes el tiempo.'));
    } finally { session.close(); if (peer) peer.terminate(); await new Promise((r) => server.close(r)); }
});

test('voice is push-to-talk, stops on hiding, and an unavailable MGU microphone never opens a cloud session', async () => {
    const config = createConfig(); await config.ready; await config.update({ key: fakeKey });
    let receives, audioEvents, peers = 0, audioClosed = 0; const sent = [];
    const options = { config, assistantConnect(c, cb) { receives = cb; peers++; return { send(m) { sent.push(m); return true; }, close() {} }; } };
    const unavailable = createAssistant(options, async () => ({})); await unavailable.ready; unavailable.setVisible(true);
    assert.equal(unavailable.listen(), false); assert.equal(peers, 0); unavailable.close();
    const a = createAssistant(Object.assign({}, options, { assistantAudio: { capture: { command: 'fixture' }, playback: {} },
        assistantAudioFactory(o, cb) { audioEvents = cb; return { listen() {}, pcm() {}, finish() {}, close() { audioClosed++; } }; } }), async () => ({}));
    await a.ready; a.setVisible(true); assert(a.listen()); receives({ type: 'ready' }); assert.equal(a.state.status, 'listening');
    audioEvents({ type: 'capture', data: 'AA==' }); assert.equal(sent[sent.length - 1].op, 'pcm');
    audioEvents({ type: 'capture-end', samples: 24000 }); assert.equal(sent[sent.length - 1].op, 'audio-end');
    assert.equal(a.state.status, 'thinking'); a.setVisible(false); assert.equal(audioClosed, 1); a.close();
});

test('settings are reachable by touch and the knob can select voices without exposing a key', async () => {
    const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
    const { controls } = require('../../native/javi-carlab/navigation-panels');
    const { Recorder } = require('./software-renderer');
    const a = createAssistant({}, async () => ({})), ui = createNavigationUI({}, () => {}); await a.ready; ui.assistant = a;
    const nav = { state: 'inactive', points: [], theme: 'night' };
    try {
        ui.update(nav, {}, true); ui.activate('settings'); controls(new Recorder(1960, 520), ui, nav);
        let button = ui.state.buttons.find((b) => b.id === 'assistant:settings'); assert(button && !button.disabled);
        ui.touch('down', button.x + 8, button.y + 8); ui.touch('up', button.x + 8, button.y + 8);
        assert.equal(ui.state.panel, 'assistant-settings'); ui.activate('assistant:voice'); controls(new Recorder(1960, 520), ui, nav);
        ui.state.focus = 'assistant:voice:marin'; ui.controller({ knob: 10, press: 0, tilt: 0 }); ui.controller({ knob: 11, press: 0, tilt: 0 });
        assert.equal(ui.state.focus, 'assistant:voice:cedar'); ui.controller({ knob: 11, press: 1, tilt: 0 }); ui.controller({ knob: 11, press: 0, tilt: 0 });
        await until(() => !a.state.saving); assert.equal(a.state.config.voices.openai, 'cedar');
    } finally { ui.close(); a.close(); }
});

test('private import rejects Android ciphertext and imports explicit plaintext only outside the project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'bmw-assistant-import-'));
    const { main } = require('../../tools/Importar-Asistente');
    try {
        const source = path.join(root, 'export.json'), destination = path.join(root, 'private');
        await fs.writeFile(source, JSON.stringify({ provider: 'gemini', keys: { gemini: fakeKey }, voices: { gemini: 'Kore' } }));
        await main(source, destination); const config = createConfig(destination); await config.ready; assert.equal(config.credentials().key, fakeKey);
        await fs.writeFile(source, JSON.stringify({ keys: { openai: 'base64/encrypted==' } })); await assert.rejects(main(source, destination));
        await assert.rejects(main(source, path.resolve('assistant-private')));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('closing audio reaps a converter and microphone that ignore graceful termination', async () => {
    const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
    const { createAudio } = require('../../native/javi-carlab/assistant-audio');
    const peers = [], events = [];
    function spawn() {
        const peer = new EventEmitter(); peer.exitCode = null;
        peer.stdin = new PassThrough(); peer.stdout = new PassThrough(); peer.stderr = new PassThrough(); peer.signals = [];
        peer.kill = (signal) => { peer.signals.push(signal || 'SIGTERM'); if (signal === 'SIGKILL') { peer.exitCode = 1; peer.emit('close', 1); } };
        peers.push(peer); return peer;
    }
    const audio = createAudio({ ffmpeg: 'fixture', playback: { command: 'fixture', args: [] }, capture: { command: 'fixture', args: [] } },
        (e) => events.push(e), { spawn });
    audio.pcm(Buffer.alloc(4800).toString('base64')); audio.listen(); audio.close();
    await until(() => peers.every((p) => p.exitCode !== null));
    assert.equal(peers.length, 2); assert(peers.every((p) => p.signals.includes('SIGKILL')));
    assert(!events.some((e) => e.type === 'capture-end'));
});
