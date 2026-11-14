'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createPhotoLoader } = require('../../native/javi-carlab/photo-loader');
const { loadPhoto } = require('../../native/javi-carlab/drivehub-data');
const { captureReason, createGateProbe } = require('../../native/javi-carlab/controller-lease');
const { createInstallation } = require('../../native/javi-carlab/installation');
const playAudio = require('../../native/javi-carlab/tdt-audio');
const { createIsolatedPlayer } = require('../../native/javi-carlab/tdt-process');
const { createTdt } = require('../../native/javi-carlab/tdtworld');
const { dropImage } = require('../../native/javi-carlab/vendor/kit_record');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('image decoding outside the UI preserves pixels and cancels obsolete queued work', async (t) => {
    const photos = createPhotoLoader();
    t.after(() => photos.close());
    let release, requested = 0;
    const first = photos.load('https://example.org/one.png', () => new Promise((resolve) => { release = resolve; }), 32, 18);
    let current = true;
    const obsolete = assert.rejects(photos.load('https://example.org/two.png', () => { requested++; return png; }, 32, 18, false, () => current), /IMAGE_CANCELLED/);
    await delay(10);
    current = false;
    release(png);
    const image = await first;
    const reference = await loadPhoto('https://example.org/one.png', async () => png, 32, 18);
    assert.deepEqual(image.data, reference.data);
    dropImage(image); dropImage(reference);
    await obsolete;
    assert.equal(requested, 0);
    await assert.rejects(photos.load('not a URL', async () => png));
});

test('audio restarts only its failed sink, drains PCM and stops bounded retries on close', async (t) => {
    const pcm = new PassThrough(), peers = [], states = [], writes = [];
    const spawn = () => {
        const peer = new EventEmitter();
        peer.stdin = new PassThrough(); peer.stdout = new PassThrough(); peer.stderr = new PassThrough();
        peer.stdin.on('data', (bytes) => writes.push(Buffer.from(bytes)));
        peer.kill = () => {};
        peers.push(peer);
        return peer;
    };
    const output = playAudio(pcm, (state) => states.push(state), null, { handshake: true, retryMs: 15, maxRetries: 1 }, spawn, { warn() {} });
    t.after(() => output.close());
    pcm.write(Buffer.alloc(4));
    peers[0].stdout.write('ready\n');
    pcm.write(Buffer.from([1, 2, 3, 4]));
    peers[0].stderr.write('tdt-pcm: stall=-11\n');
    peers[0].emit('close', 8);
    pcm.write(Buffer.alloc(9600));
    assert.equal(pcm.isPaused(), false);
    await delay(35);
    assert.equal(peers.length, 2);
    peers[1].stdout.write('ready\n');
    pcm.write(Buffer.from([5, 6, 7, 8]));
    assert.deepEqual(writes, [Buffer.from([1, 2, 3, 4]), Buffer.from([5, 6, 7, 8])]);
    peers[0].emit('close', 8); // A late old-child event must not kill the new sink.
    assert.equal(states.at(-1), 'audio-ready');
    peers[1].emit('close', 8);
    await delay(45);
    assert.equal(peers.length, 2);
    output.close();
    pcm.write(Buffer.alloc(4));
    assert.equal(peers.length, 2);
});

test('a cancelled channel logo is retried after returning to TDT', async (t) => {
    let rejectPhoto, requests = 0;
    const channel = { id: 'one', name: 'One', group: 'Generalistas', logo: 'https://example.org/one.png', sources: [] };
    const tdt = createTdt({ fixture: { tdtChannels: [channel] }, photo() {
        requests++;
        return new Promise((resolve, reject) => { rejectPhoto = reject; });
    } }, () => {});
    t.after(() => tdt.close());
    tdt.update(0, true);
    tdt.update(1, false);
    rejectPhoto(Object.assign(new Error('cancelled'), { code: 'IMAGE_CANCELLED' }));
    await delay(10);
    tdt.update(2, true);
    assert.equal(requests, 2);
    rejectPhoto(Object.assign(new Error('cancelled'), { code: 'IMAGE_CANCELLED' }));
    await delay(10);
});

test('a terminal decoder failure closes the isolated worker and its proxy', async (t) => {
    let closed = 0;
    const player = createIsolatedPlayer({ video() {} }, {
        ffmpeg: path.join(os.tmpdir(), 'bmw-no-such-ffmpeg-binary'),
        proxy: async () => ({ url: 'http://127.0.0.1:1', close() { closed++; } })
    });
    t.after(() => player.stop());
    player.ready({ video: true });
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('decoder did not report failure')), 5000);
        player.start(['https://example.org/missing.mpd'], (state) => {
            if (state === 'unavailable' || state === 'error') { clearTimeout(timeout); resolve(); }
        });
    });
    assert.equal(closed, 1);
    assert.equal(player.frame(), undefined);
});

test('an abrupt multimedia-worker exit removes only its validated shared ring', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-ring-owner-'));
    const ring = path.join(directory, 'mgu-video-bmwlauncher-0123456789abcdef');
    fs.writeFileSync(ring, Buffer.alloc(64));
    const peer = new EventEmitter();
    peer.stderr = new PassThrough(); peer.connected = true; peer.exitCode = 1;
    peer.send = () => {}; peer.disconnect = () => { peer.connected = false; }; peer.kill = () => {};
    const player = createIsolatedPlayer({ video() {} }, { directory, forkProcess: () => peer });
    t.after(() => { player.stop(); assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true }); });
    player.ready({ video: true });
    player.start(['https://example.org/test.mpd'], () => {});
    await delay(10);
    peer.emit('message', { type: 'video', file: ring });
    assert.deepEqual(player.frame(), { id: 1 });
    peer.emit('exit', 1);
    await delay(20);
    assert.equal(fs.existsSync(ring), false);
    assert.equal(player.frame(), undefined);
});

test('capture requires current context and yields on coverage, missing input or exit failure', () => {
    const state = { visible: true, contextAt: 1000, gate: true, returnContext: {}, ccuReady: true, screenConfirmed: true };
    assert.equal(captureReason(state, 1700), 'Captura activa');
    assert.notEqual(captureReason(state, 1801), 'Captura activa');
    for (const key of ['visible', 'gate', 'returnContext', 'ccuReady', 'screenConfirmed'])
        assert.notEqual(captureReason(Object.assign({}, state, { [key]: false }), 1100), 'Captura activa');
    assert.notEqual(captureReason(Object.assign({}, state, { exitFailed: true }), 1100), 'Captura activa');
});

test('installation and gate discovery use the actual OAP identity and invalidate a dead HMI', async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-runtime-test-'));
    t.after(() => { assert.equal(path.dirname(directory), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true }); });
    fs.mkdirSync(path.join(directory, 'oap_12201/security'), { recursive: true });
    fs.mkdirSync(path.join(directory, 'oap_13330/rhmiData'), { recursive: true });
    fs.writeFileSync(path.join(directory, 'oap_12201/security/uids.txt'), '13330=javi_carlauncher\n');
    fs.writeFileSync(path.join(directory, 'oap_13330/rhmiData/application.json'), JSON.stringify({ application: { name: 'javi_carlauncher', appletId: 88 } }));
    const inspect = createInstallation(directory, 'javi_carlauncher');
    assert.deepEqual(await inspect(), { uid: 13330, applet: 88 });
    fs.mkdirSync(path.join(directory, '42'));
    fs.writeFileSync(path.join(directory, '42/comm'), 'Hmi8\n');
    fs.writeFileSync(path.join(directory, '42/maps'), '10000000-10001000 r-xp 0 0 0 /var/opt/javi-ccu-gate/current/javi-ccu-gate.so\n');
    const probe = createGateProbe(directory);
    assert.equal(await probe(), true);
    fs.writeFileSync(path.join(directory, '42/comm'), 'another-process\n');
    assert.equal(await probe(), false);
});

test('installing BMWLauncher requests its ID8 controller filter and every worker is packaged', () => {
    const repository = require('../../mgu-repo.json');
    const app = repository.components.find((item) => item.id === 'javi_carlauncher');
    assert.equal(app.requires['javi-ccu-gate'], '1.0.0');
    const renderer = require('../../native/javi-carlab/component.json');
    for (const name of ['photo-loader.js', 'photo-worker.js', 'tdt-process.js', 'tdt-worker.js', 'tdt-audio.js', 'tdt-dash.js', 'tdt-dash-relay.js', 'installation.js']) {
        assert(renderer.files.some((item) => item.path === name));
        assert(fs.existsSync(path.join(__dirname, '../../native/javi-carlab', name)));
    }
});
