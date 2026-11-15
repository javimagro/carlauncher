'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const catalog = require('../../native/javi-carlab/tdt-catalog');
const { createPlayer, createRing } = require('../../native/javi-carlab/tdt-player');
const { createTdt } = require('../../native/javi-carlab/tdtworld');
const { Recorder } = require('../../native/javi-carlab/vendor/kit_record');

const first = { id: 'la1', epg: 'La1.TV', name: 'La 1', group: 'Generalistas', sources: ['https://example.com/uno.m3u8'] };
const second = { id: 'la2', epg: 'La2.TV', name: 'La 2', group: 'Generalistas', sources: ['https://example.com/dos.mpd'] };
const goodPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

function int(n) {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(n);
    return bytes;
}

function time(n) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigInt64BE(BigInt(n));
    return bytes;
}

function string(value) {
    const bytes = Buffer.from(value);
    return Buffer.concat([int(bytes.length), bytes]);
}

async function eventually(condition) {
    for (let i = 0; i < 60; i++) {
        if (condition()) return;
        await delay(20);
    }
    assert.ok(condition(), 'Timed out waiting for TDTWorld');
}

test('catalogues accept direct HLS and DASH, preserving programme aliases and time-keyed fanart', async () => {
    const json = { countries: [{ name: 'Spain', ambits: [{ name: 'Generalistas', channels: [{
        name: 'La 1', epg_id: 'La1.TV', options: [
            { format: 'youtube', url: 'https://example.com/live' },
            { format: 'm3u8', url: 'https://example.com/play?id=[DEVICE_ID]' },
            { format: 'm3u8', url: 'https://example.com/uno.m3u8' }
        ]
    }] }] }] };
    assert.deepEqual(catalog.parseCatalog(JSON.stringify(json))[0].sources, first.sources);
    const markdown = '## Nacionales\n| La 1 | [m3u8 # 1](https://example.com/uno.m3u8) | - | - | La1.TV | - |';
    assert.equal(catalog.parseMarkdown(markdown)[0].id, first.id);
    assert.deepEqual(catalog.parseM3u('#EXTINF:-1 tvg-id="La2.TV",La 2\nhttps://example.com/dos.mpd')[0].sources, second.sources);
    const start = 1794421200000;
    const end = start + 1800000;
    const guide = catalog.parseGuide(Buffer.concat([
        int(0x54444744), int(2), time(start), time(start), time(end), int(1), int(1),
        string('Informativo'), string('Noticias'), string('Información'), string(''), time(start), time(end),
        int(1), string(first.epg), int(0)
    ]));
    const programme = catalog.schedule(guide, first)[0];
    assert.deepEqual([programme.title, programme.start, programme.end], ['Informativo', start, end]);
    const images = catalog.parseFanart(Buffer.concat([
        int(0x54444641), int(1), int(1), string('La1.TV'), time(start), string('https://example.com/programa.jpg')
    ]));
    assert.equal(images.get(first.id + ':' + programme.start), 'https://example.com/programa.jpg');
    assert.equal(images.get(first.id + ':' + programme.end), undefined);
});

test('switching channel and programme discards fanart that arrives after the focus moved', async (t) => {
    const current = { title: 'Actual', start: 0, end: 100 };
    const next = { title: 'Siguiente', start: 100, end: 200 };
    const requested = [];
    let completeFirst;
    const fixture = {
        tdtChannels: [first, second],
        tdtGuide: { aliases: new Map([[first.epg, [current, next]], [second.epg, [current]]]) },
        tdtFanart: new Map([
            ['la1:0', 'https://example.com/actual.png'],
            ['la1:100', 'https://example.com/siguiente.png'],
            ['la2:0', 'https://example.com/otro.png']
        ])
    };
    const tdt = createTdt({ fixture, now: () => 50, get(url) {
        requested.push(url.split('/').pop());
        if (url.endsWith('/actual.png')) return new Promise((resolve) => { completeFirst = resolve; });
        return Promise.resolve(goodPng);
    } }, () => {});
    t.after(() => tdt.close());
    tdt.update(50, true);
    await eventually(() => completeFirst);
    tdt.tilt(1);
    tdt.update(50, true);
    await eventually(() => tdt.state.art);
    const expected = tdt.state.art;
    completeFirst(goodPng);
    await delay(50);
    assert.equal(tdt.state.art, expected);
    assert.equal(tdt.program(tdt.selected(), 50, true).title, 'Siguiente');
    tdt.rotate(1);
    tdt.update(50, true);
    assert.equal(tdt.state.art, undefined);
    await eventually(() => tdt.state.art);
    assert.deepEqual(requested, ['actual.png', 'siguiente.png', 'otro.png']);
    assert.equal(tdt.program(tdt.selected(), 50, true).title, 'Actual');
});

test('Atres retuning selects DASH before failing legacy HLS and never repeats an identical source', async () => {
    const hls = 'https://cdn.example.org/hlsts/master.m3u8';
    const legacy = 'https://cdn.example.org/hlslegacy/master.m3u8';
    const dash = 'https://cdn.example.org/dasht/manifest.mpd?session=fixture';
    const sources = [hls, legacy, legacy, dash].map((src) => ({ src }));
    sources.push({ src: 'https://cdn.example.org/protected.mpd', drm: true });
    const channel = { name: 'La Sexta', sources: [] };
    let lookups = 0;
    const resolve = () => catalog.resolveSources(channel, async () => {
        lookups++;
        return Buffer.from(JSON.stringify({ sourcesLive: sources }));
    });
    assert.deepEqual(await resolve(), [dash, hls, legacy]);
    assert.deepEqual(await resolve(), [dash, hls, legacy]);
    assert.equal(lookups, 2, 'each retune resolves current CDN credentials');
    assert.deepEqual(channel.sources, [], 'do not cache tokenized sources in the catalogue');
    const onlyHls = await catalog.resolveSources(channel, async () => JSON.stringify({ sourcesLive: [{ src: hls }] }));
    assert.deepEqual(onlyHls, [hls]);
    assert.deepEqual(await catalog.resolveSources(first, () => assert.fail()), first.sources);
});

test('changing channel retunes and hiding TDT releases playback; settings and last channel persist', async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-settings-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const tuned = [];
    let stops = 0;
    const player = { start(sources, change) { tuned.push(sources[0]); change('playing'); }, stop() { stops++; } };
    const opts = { fixture: { tdtChannels: [first, second] }, tdtDirectory: dir, tdtPlayer: player };
    const tdt = createTdt(opts, () => {});
    t.after(() => tdt.close());
    tdt.update(Date.now(), true);
    tdt.press(true);
    assert.equal(tdt.state.mode, 'settings');
    assert.deepEqual(tdt.settings().map((item) => item.label), ['País', 'Duración de la información', 'Iniciar en el último canal']);
    tdt.rotate(1);
    tdt.press(false);
    assert.equal(tdt.state.prefs.seconds, 8);
    tdt.rotate(1);
    tdt.press(false);
    assert.equal(tdt.state.prefs.resume, true);
    tdt.press(true);
    assert.equal(tdt.state.mode, 'browse');
    assert.equal(tuned.length, 0);
    tdt.press(false);
    await eventually(() => tuned.length === 1);
    tdt.rotate(1);
    await eventually(() => tuned.length === 2);
    assert.deepEqual(tuned, first.sources.concat(second.sources));
    const before = stops;
    tdt.update(Date.now(), false);
    assert.equal(stops, before + 1);
    assert.equal(tdt.state.mode, 'browse');
    tdt.close();
    const restored = createTdt(opts, () => {});
    t.after(() => restored.close());
    assert.equal(restored.state.prefs.seconds, 8);
    assert.equal(restored.state.prefs.resume, true);
    assert.equal(restored.selected().id, second.id);
    restored.update(Date.now(), true);
    await eventually(() => tuned.length === 3);
    assert.equal(tuned[2], second.sources[0]);
});

test('Spanish catalogues exclude foreign entries and preview countries return independent lists', () => {
    const entry = (name) => ({ name, epg_id: name, options: [{ format: 'm3u8', url: first.sources[0] }] });
    const region = (name, channel) => ({ name, ambits: [{ name: 'Generalistas', channels: [entry(channel)] }] });
    ['Spain', 'España'].forEach((name) => {
        const result = catalog.parseCatalog(JSON.stringify({ countries: [region('France', 'France 2'), region(name, 'La 1')] }));
        assert.deepEqual(result.map((item) => item.name), ['La 1']);
    });
    assert.throws(() => catalog.parseCatalog(JSON.stringify({ countries: [region('France', 'France 2')] })), /Catálogo vacío/);
    const markdown = '## Nacionales\n| La 1 | [m3u8](https://example.com/uno.m3u8) | - | - | La1.TV | - |\n'
        + '## Int. Francia\n| France 2 | [m3u8](https://example.com/dos.m3u8) | - | - | France2 | - |';
    assert.deepEqual(catalog.parseMarkdown(markdown).map((item) => item.name), ['La 1']);
    const { previewChannels } = require('../../native/javi-carlab/tdtworld-data');
    const spanish = previewChannels('es'), portuguese = previewChannels('pt');
    assert.equal(portuguese[0].name, 'RTP 1');
    assert.equal(spanish[0].name, 'La 1');
    spanish[0].name = 'changed in caller';
    assert.equal(previewChannels('es')[0].name, 'La 1');
});

test('changing country replaces the displayed catalogue and ignores a late response from the previous country', async (t) => {
    const { layout } = require('../../native/javi-carlab/tdtworld');
    const { viewport } = require('../../native/javi-carlab/drivehub-state');
    const { w, h } = viewport, rows = layout(w, h);
    function nextCountry(tdt) {
        if (tdt.state.mode !== 'settings') tdt.touch(rows.actionX + 10, 17, w, h);
        tdt.touch(w - 45, rows.settingsTop + 15, w, h);
    }
    const demo = createTdt({ fixture: {} }, () => {});
    t.after(() => demo.close());
    assert.equal(demo.selected().name, 'La 1');
    nextCountry(demo); assert.equal(demo.selected().name, 'RTP 1');
    nextCountry(demo); assert.equal(demo.selected().name, 'Das Erste');

    let resolveSpain;
    const live = createTdt({ get(url) {
        if (url.endsWith('/tv.json')) return new Promise((resolve) => { resolveSpain = resolve; });
        if (url.endsWith('/pt.m3u')) return Promise.resolve(Buffer.from('#EXTINF:-1 tvg-id="RTP1.pt",RTP 1\nhttps://example.com/rtp.m3u8'));
        return Promise.reject(new Error('offline'));
    } }, () => {});
    t.after(() => live.close());
    live.update(1000, true);
    nextCountry(live);
    assert.deepEqual(live.state.channels, []);
    live.update(1000, true);
    await eventually(() => live.selected());
    resolveSpain(Buffer.from(JSON.stringify({ countries: [{ name: 'Spain', ambits: [{ channels: [{ name: 'La 1' }] }] }] })));
    await delay(10);
    assert.deepEqual(live.state.channels.map((channel) => channel.name), ['RTP 1']);
});

test('player channel picker waits for confirmation and selecting the current channel does not retune', async (t) => {
    const tuned = [];
    const tdt = createTdt({ fixture: { tdtChannels: [first, second] }, tdtPlayer: {
        start(sources, change) { tuned.push(sources[0]); change('playing'); }, stop() {}
    } }, () => {});
    t.after(() => tdt.close());
    tdt.update(Date.now(), true); tdt.press(false);
    await eventually(() => tuned.length === 1);
    tdt.press(true); tdt.rotate(1);
    assert.equal(tdt.state.playerChoice, 1);
    assert.equal(tdt.selected().id, first.id);
    assert.equal(tuned.length, 1);
    tdt.press(false);
    await eventually(() => tuned.length === 2);
    assert.equal(tdt.selected().id, second.id);
    assert.equal(tdt.state.playerChoice, undefined);
    tdt.press(true); tdt.press(false);
    assert.equal(tuned.length, 2);
    assert.equal(tdt.state.playerChoice, undefined);
});

test('touching a different row starts playback immediately and leaving the card cancels a pending tune', async (t) => {
    const tuned = [], { layout } = require('../../native/javi-carlab/tdtworld');
    const { viewport } = require('../../native/javi-carlab/drivehub-state');
    const { w, h } = viewport, rows = layout(w, h);
    const tdt = createTdt({ fixture: { tdtChannels: [first, second] }, tdtPlayer: {
        start(sources, change) { tuned.push(sources[0]); change('playing'); }, stop() {}
    } }, () => {});
    t.after(() => tdt.close());
    tdt.update(Date.now(), true);
    tdt.touch(46, rows.top + rows.rowHeight + 18, w, h);
    assert.equal(tdt.state.mode, 'player');
    await eventually(() => tuned.length === 1);
    assert.deepEqual(tuned, second.sources);
    tdt.touch(rows.actionX + 10, 18, w, h);
    tdt.rotate(-1); assert.equal(tdt.selected().id, first.id); assert.equal(tuned.length, 1);
    tdt.press(false); tdt.update(Date.now(), false);
    await delay(10);
    assert.deepEqual(tuned, second.sources);
});

test('shared video rotates slots and records the renderer video operation', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-ring-'));
    const ring = createRing(dir, 16, 16);
    t.after(() => { if (fs.existsSync(ring.file)) ring.close(); fs.rmdirSync(dir); });
    for (let i = 1; i <= 4; i++) ring.push(Buffer.alloc(384, i));
    const bytes = fs.readFileSync(ring.file);
    assert.equal(bytes.readUInt32LE(0), 0x4656474d);
    assert.equal(bytes.readUInt32LE(16), 4);
    const slot = bytes.readUInt32LE(20);
    assert.equal(slot, 1);
    assert.equal(bytes[64 + slot * 384], 4);
    const cv = new Recorder(1960, 520);
    cv.video(1, 1059, 49, 888, 462);
    assert.equal(cv.words()[0], 19);
    assert.equal(cv.words()[6], 1);
    ring.close();
    assert.ok(!fs.existsSync(ring.file));
});

test('video continues through audio backpressure and keeps its last frame while reconnecting', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-reconnect-'));
    const decoders = [];
    const audioWrites = [];
    const states = [];
    const diagnostics = [];
    const videoDiagnostics = [];
    let attachment;
    let sink;
    const player = createPlayer({ video(id, file) { attachment = file; } }, {
        directory,
        bufferSeconds: 0,
        get: async () => Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1280x720\nhi.m3u8\n'
            + '#EXT-X-STREAM-INF:BANDWIDTH=1100000,RESOLUTION=640x360,AUDIO="aac"\nlo.m3u8\n'),
        audio: { command: 'sink', args: [], handshake: true },
        log: { warn() {} },
        spawnProcess(command, args) {
            const child = new EventEmitter();
            child.kill = () => {};
            child.stdout = new PassThrough();
            child.stderr = new PassThrough();
            if (command === 'sink') {
                sink = child;
                child.stdin = new EventEmitter();
                child.stdin.write = (bytes) => { audioWrites.push(bytes); return false; };
            } else {
                assert(args.includes('pipe:3'));
                assert(args.includes('0:p:1:v:0'));
                assert(args.includes('0:p:1:a:0'));
                child.stdio = [null, child.stdout, child.stderr, new PassThrough()];
                decoders.push(child);
            }
            return child;
        }
    });
    t.after(() => { player.stop(); fs.rmdirSync(directory); });
    player.ready({ video: true });
    player.start(first.sources, (status, diagnostic) => {
        states.push(status);
        if (diagnostic) (status.startsWith('audio-') ? diagnostics : videoDiagnostics).push(diagnostic);
    });
    await new Promise((resolve) => setImmediate(resolve));
    const frame = Buffer.alloc(640 * 360 * 3 / 2);
    const decoder = decoders[0];
    decoder.stdio[3].write(Buffer.alloc(1, 1));
    sink.stdout.write('ready\n');
    decoder.stdio[3].write(Buffer.alloc(3, 2));
    decoder.stdio[3].write(Buffer.alloc(8, 3));
    decoder.stdout.write(frame);
    decoder.stdout.write(frame);
    assert.equal(decoder.stdio[3].isPaused(), false);
    assert.deepEqual(audioWrites, [Buffer.from([1, 2, 2, 2])]);
    const file = attachment;
    assert.equal(fs.readFileSync(file).readUInt32LE(16), 2);
    sink.stderr.write('tdt-pcm: format=');
    sink.stderr.write('-22\n');
    sink.emit('close', 5);
    assert(states.includes('audio-format'));
    assert.deepEqual(diagnostics, ['format=-22']);
    decoder.stderr.write('Server returned 503 Service Unavailable\n');
    decoder.emit('close', 1);
    assert.equal(states[states.length - 1], 'reconnecting');
    assert.deepEqual(player.frame(), { id: 1 });
    assert.equal(attachment, file);
    assert.deepEqual(videoDiagnostics, ['HTTP 503']);
    for (let i = 0; i < 50 && decoders.length < 2; i++) await delay(40);
    assert.equal(decoders.length, 2);
    decoders[1].stdout.write(frame);
    assert.equal(states[states.length - 1], 'playing');
    assert.equal(fs.readFileSync(file).readUInt32LE(16), 3);
});

test('playout starts with buffered video, preserves the last frame on depletion and resumes', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-buffer-'));
    const decoder = new EventEmitter();
    decoder.kill = () => {};
    decoder.stdout = new PassThrough();
    decoder.stderr = new PassThrough();
    const statuses = [];
    let attachment;
    const player = createPlayer({ video(id, file) { attachment = file; } }, {
        directory, bufferSeconds: 0.15, spawnProcess: () => decoder
    });
    t.after(() => { player.stop(); fs.rmdirSync(directory); });
    player.ready({ video: true });
    player.start(first.sources, (status) => statuses.push(status));
    await new Promise((resolve) => setImmediate(resolve));
    const frame = Buffer.alloc(640 * 360 * 3 / 2);
    decoder.stdout.write(frame);
    decoder.stdout.write(frame);
    await delay(80);
    assert.equal(attachment, undefined);
    decoder.stdout.write(frame);

    for (let i = 0; i < 25 && !statuses.includes('buffering'); i++) await delay(20);
    assert.deepEqual(statuses, ['playing', 'buffering']);
    const file = attachment;
    assert.equal(fs.readFileSync(file).readUInt32LE(16), 3);

    for (let i = 0; i < 3; i++) decoder.stdout.write(frame);
    for (let i = 0; i < 25 && statuses.length < 3; i++) await delay(20);
    assert.deepEqual(statuses, ['playing', 'buffering', 'playing']);
    assert.equal(attachment, file);
    assert.ok(fs.readFileSync(file).readUInt32LE(16) > 3);
});


test('a segment burst applies video backpressure and plays every queued frame', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-burst-'));
    const decoder = new EventEmitter();
    decoder.kill = () => {};
    decoder.stdout = new PassThrough(); decoder.stderr = new PassThrough();
    let attachment;
    const player = createPlayer({ video(id, file) { attachment = file; } }, {
        directory, bufferSeconds: 0.15, spawnProcess: () => decoder
    });
    t.after(() => { player.stop(); fs.rmdirSync(directory); });
    player.ready({ video: true }); player.start(first.sources, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    decoder.stdout.write(Buffer.alloc(640 * 360 * 3 / 2 * 10));
    assert.equal(decoder.stdout.isPaused(), true);
    await eventually(() => attachment && fs.readFileSync(attachment).readUInt32LE(16) === 10);
    assert.equal(decoder.stdout.isPaused(), false);
    // Cancelling another full burst releases the pipe and ignores old frames.
    decoder.stdout.write(Buffer.alloc(640 * 360 * 3 / 2 * 10));
    assert.equal(decoder.stdout.isPaused(), true);
    player.stop();
    assert.equal(decoder.stdout.isPaused(), false);
    assert.equal(attachment, null);
});

test('an initial HTTP failure retries with audio and never downgrades silently to video only', async (t) => {
    const decoders = [], states = [];
    const player = createPlayer({ video() {} }, { directory: os.tmpdir(), audio: { command: 'sink', args: [] },
        log: { warn() {} }, spawnProcess(command, args) {
            assert.notEqual(command, 'sink');
            const peer = new EventEmitter(); peer.kill = () => {};
            peer.stdout = new PassThrough(); peer.stderr = new PassThrough();
            peer.stdio = [null, peer.stdout, peer.stderr, new PassThrough()];
            decoders.push({ peer, args }); return peer;
        } });
    t.after(() => player.stop());
    player.ready({ video: true }); player.start(first.sources, (status) => states.push(status));
    await delay(10);
    decoders[0].peer.stderr.write('HTTP error 503 Service Unavailable\n');
    decoders[0].peer.emit('close', 1);
    assert(states.includes('reconnecting'));
    assert.equal(decoders.length, 1, 'retry is bounded and delayed');
    for (let i = 0; i < 30 && decoders.length < 2; i++) await delay(50);
    assert.equal(decoders.length, 2);
    assert(decoders[1].args.includes('pipe:3'), 'a network fault must not remove the PCM output');
    assert(!states.includes('audio-unavailable'));
});

test('decoded PCM is throttled only with buffered video and drains after sink failure or cancellation', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tdt-pcm-flow-'));
    const decoder = new EventEmitter(), sink = new EventEmitter();
    decoder.kill = sink.kill = () => {};
    decoder.stdout = new PassThrough(); decoder.stderr = new PassThrough();
    decoder.stdio = [null, decoder.stdout, decoder.stderr, new PassThrough()];
    sink.stdin = new PassThrough(); sink.stderr = new PassThrough(); sink.stdin.resume();
    let attachment;
    const player = createPlayer({ video(id, file) { attachment = file; } }, {
        directory, bufferSeconds: 0.15, audio: { command: 'sink', args: [], maxRetries: 0 },
        log: { warn() {} }, spawnProcess: (command) => command === 'sink' ? sink : decoder
    });
    t.after(() => { player.stop(); fs.rmdirSync(directory); });
    player.ready({ video: true }); player.start(first.sources, () => {});
    await new Promise((resolve) => setImmediate(resolve));
    decoder.stdio[3].write(Buffer.alloc(64000));
    assert.equal(decoder.stdio[3].isPaused(), false, 'PCM alone must not prevent the first video frame');
    decoder.stdout.write(Buffer.alloc(640 * 360 * 3 / 2 * 6));
    assert.equal(decoder.stdio[3].isPaused(), true, 'preserve decoded-ahead PCM instead of dropping it');
    sink.emit('close', 8);
    await eventually(() => attachment && fs.readFileSync(attachment).readUInt32LE(16) === 6);
    assert.equal(decoder.stdio[3].isPaused(), false, 'ALSA failure must not leave the decoder blocked');
    decoder.stdio[3].write(Buffer.alloc(64000));
    decoder.stdout.write(Buffer.alloc(640 * 360 * 3 / 2 * 6));
    assert.equal(decoder.stdio[3].isPaused(), true);
    player.stop();
    assert.equal(decoder.stdio[3].isPaused(), false);
    assert.equal(decoder.stdout.isPaused(), false);
});

test('only a confirmed missing audio stream permits a video-only recovery', async (t) => {
    const decoders = [], states = [];
    const player = createPlayer({ video() {} }, { directory: os.tmpdir(), audio: { command: 'sink', args: [] },
        log: { warn() {} }, spawnProcess(command, args) {
            const peer = new EventEmitter(); peer.kill = () => {};
            peer.stdout = new PassThrough(); peer.stderr = new PassThrough();
            peer.stdio = [null, peer.stdout, peer.stderr, new PassThrough()];
            decoders.push({ peer, args }); return peer;
        } });
    t.after(() => player.stop()); player.ready({ video: true });
    player.start(first.sources, (status) => states.push(status)); await delay(10);
    decoders[0].peer.stderr.write("Stream map '0:a:0' matches no streams.\n");
    decoders[0].peer.emit('close', 1);
    assert.equal(decoders.length, 2);
    assert(!decoders[1].args.includes('pipe:3'));
    assert(states.includes('audio-unavailable'));
});
