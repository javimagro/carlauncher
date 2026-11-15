'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createMux, crc } = require('../../native/javi-carlab/aa-ts-mux');
const { geometry, resolveGeometry, fitGeometry, createReader, nals, spsSize, cropFrame, mapInputPoint } = require('../../native/javi-carlab/aa-frame');
const { createPlayer } = require('../../native/javi-carlab/aa-player');
const { createAAPlayer } = require('../../native/javi-carlab/aa-process');

function sps(width = 1920, height = 1080) {
    let bits = '';
    function u(n, count) { bits += n.toString(2).padStart(count, '0'); }
    function ue(n) { const v = (n + 1).toString(2); bits += '0'.repeat(v.length - 1) + v; }
    u(66, 8); u(0, 8); u(31, 8); ue(0); ue(0); ue(0); ue(0); ue(1); u(0, 1);
    ue(width / 16 - 1); ue(Math.ceil(height / 16) - 1); u(1, 1); u(1, 1); u(1, 1);
    ue(0); ue(0); ue(0); ue((Math.ceil(height / 16) * 16 - height) / 2); u(0, 1); u(1, 1);
    while (bits.length % 8) bits += '0';
    return Buffer.from([0x67].concat(bits.match(/.{8}/g).map(v => parseInt(v, 2))));
}
const nal = bytes => Buffer.concat([Buffer.from([0, 0, 0, 1]), bytes]);
const pframe = nal(Buffer.from([0x41, 0x80, 1, 2]));
const keyframe = (width) => Buffer.concat([nal(sps(width)), nal(Buffer.from([0x68, 0xaa])), nal(Buffer.from([0x65, 0x80]))]);
function record(data, timeMs = 1000, pid = 77, reserved = 0) {
    const head = Buffer.alloc(64), ns = Math.round(timeMs * 1000000);
    head.writeUInt32LE(0x31464141, 0); head.writeUInt32LE(64, 4);
    head.writeUInt32LE(ns >>> 0, 8); head.writeUInt32LE(Math.floor(ns / 4294967296), 12);
    head.writeUInt32LE(0x30, 24); head.writeUInt32LE(data.length, 32); head.writeUInt32LE(data.length, 36);
    head.writeUInt32LE(pid, 48); head.writeUInt32LE(pid + 1, 52); head.writeUInt32LE(reserved, 60);
    return Buffer.concat([head, data]);
}
function child() {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
    c.stdin = new EventEmitter(); c.stdin.bytes = []; c.stdin.destroyed = false;
    c.stdin.write = b => { c.stdin.bytes.push(Buffer.from(b)); return true; };
    c.stdin.end = b => { if (b) c.stdin.bytes.push(Buffer.from(b)); c.stdin.destroyed = true; };
    c.exitCode = null; c.connected = true; c.messages = [];
    c.send = (m, cb) => { c.messages.push(m); if (cb) cb(); };
    c.disconnect = () => { c.connected = false; };
    c.kill = () => { c.exitCode = 0; c.emit('exit', 0); c.emit('close', 0); };
    return c;
}
function fixture(t, extra) {
    const children = [], messages = [], frames = [], ring = { file: '/dev/shm/mgu-video-bmwlauncher-0123456789abcdef', closed: false,
        push(b) { frames.push(Buffer.from(b)); }, close() { this.closed = true; } };
    const player = createPlayer(Object.assign({ ffmpeg: 'decoder', capture: 'capture', createRing: (directory, width, height) => { ring.width = width; ring.height = height; return ring; },
        spawnProcess(file, args) { const c = child(); c.file = file; c.args = args; children.push(c); return c; } }, extra), m => messages.push(m));
    player.start({ pid: 77, starttime: '123456', profile: 'mgu21-aa-20261115' });
    t.after(() => { player.stop(); children.forEach(c => c.kill()); });
    return { player, children, decoder: children[0], capture: children[1], messages, frames, ring };
}

test('AAF1 accepts fragmented/multiple complete records and rejects another process/display or truncation', () => {
    const got = [], reader = createReader(77, frame => got.push(frame));
    const bytes = Buffer.concat([record(pframe, 5), record(keyframe(), 5000)]);
    for (let i = 0; i < bytes.length; i += 7) reader.push(bytes.slice(i, i + 7));
    reader.end(); assert.equal(got.length, 2); assert.deepEqual(got[0].data, pframe); assert.equal(got[1].timeMs, 5000);
    assert.throws(() => createReader(78, () => {}).push(record(pframe)), /HEADER/);
    const wrongDisplay = record(pframe); wrongDisplay.writeUInt32LE(1, 56);
    assert.throws(() => createReader(77, () => {}).push(wrongDisplay), /HEADER/);
    const partial = createReader(77, () => {}); partial.push(record(pframe).slice(0, 67)); assert.throws(() => partial.end(), /TRUNCATED/);
    const huge = record(pframe); huge.writeUInt32LE(262145, 32); assert.throws(() => createReader(77, () => {}).push(huge), /HEADER/);
});

test('SPS dimensions match the encoded picture, including 1088-to-1080 cropping', () => {
    assert.deepEqual(spsSize(sps()), { width: 1920, height: 1080 });
    assert.deepEqual(spsSize(sps(1280, 720)), { width: 1280, height: 720 });
    assert.throws(() => spsSize(Buffer.from([0x67, 0, 0, 0])), /SPS/);
    assert.deepEqual(nals(keyframe()).map(unit => unit.type), [7, 8, 5]);
});

test('AA crop preserves full-width controls and each YUV plane; touch excludes letterbox', () => {
    assert.equal(geometry.width, 1536); assert.equal(geometry.height, 448);
    assert.equal(geometry.decodedWidth, 1536); assert.equal(geometry.decodedHeight, 864);
    const luma = geometry.decodedWidth * geometry.decodedHeight, targetLuma = geometry.width * geometry.height;
    const source = Buffer.alloc(luma * 3 / 2), target = Buffer.alloc(targetLuma * 3 / 2);
    for (let y = 0; y < geometry.decodedHeight; y++) source.fill(y & 255, y * geometry.decodedWidth, (y + 1) * geometry.decodedWidth);
    for (let y = 0; y < geometry.decodedHeight / 2; y++) {
        const from = y * geometry.decodedWidth / 2, to = (y + 1) * geometry.decodedWidth / 2;
        source.fill((y + 73) & 255, luma + from, luma + to);
        source.fill((y + 169) & 255, luma * 5 / 4 + from, luma * 5 / 4 + to);
    }
    cropFrame(source, target);
    assert.equal(target[0], 208); assert.equal(target[geometry.width - 1], 208); assert.equal(target[targetLuma - 1], 143);
    assert.equal(target[targetLuma], 177); assert.equal(target[targetLuma * 5 / 4 - 1], 144);
    assert.equal(target[targetLuma * 5 / 4], 17); assert.equal(target[target.length - 1], 240);
    assert.throws(() => cropFrame(source.slice(1), target), /AA_PIXEL_SIZE/);
    const box = { x: 10, y: 20, w: 960, h: 480 };
    assert.equal(mapInputPoint(box, 10, 119), null);
    assert.deepEqual(mapInputPoint(box, 10, 120), { x: 0, y: 260, contentX: 0, contentY: 0 });
    assert.deepEqual(mapInputPoint(box, 490, 260), { x: 960, y: 540, contentX: 960, contentY: 280 });
    assert.equal(mapInputPoint(box, 970, 400), null);
    assert.deepEqual(mapInputPoint(box, 2000, 2000, true), { x: 1919, y: 819, contentX: 1919, contentY: 559 });
});

function unpackTs(bytes) {
    const pes = [], seen = new Map(); let pts;
    for (let at = 0; at < bytes.length; at += 188) {
        const b = bytes.slice(at, at + 188); assert.equal(b.length, 188); assert.equal(b[0], 0x47);
        const pid = ((b[1] & 31) << 8) | b[2], continuity = b[3] & 15;
        if (seen.has(pid)) assert.equal(continuity, (seen.get(pid) + 1) & 15); seen.set(pid, continuity);
        let payload = 4; if (b[3] & 0x20) payload += b[4] + 1;
        if (pid === 0 || pid === 4096) {
            payload += b[payload] + 1;
            const length = ((b[payload + 1] & 15) << 8) | b[payload + 2];
            const section = b.slice(payload, payload + 3 + length);
            assert.deepEqual(crc(section), Buffer.alloc(4));
        } else if (pid === 256) {
            const body = b.slice(payload);
            if (b[1] & 0x40) {
                assert.deepEqual(body.slice(0, 4), Buffer.from([0, 0, 1, 0xe0]));
                const p = body.slice(9, 14);
                pts = ((p[0] >> 1) & 7) * 1073741824 + p[1] * 4194304 + (p[2] >> 1) * 32768 + p[3] * 128 + (p[4] >> 1);
                pes.push(body.slice(14));
            } else pes.push(body);
        }
    }
    return { data: Buffer.concat(pes), pts };
}

test('MPEG-TS retains bytes, CRC/continuity and monotonic PTS including large frames', () => {
    const mux = createMux(), source = Buffer.alloc(240000, 0x5a);
    const first = unpackTs(mux(source, 100, 0x10)); assert.deepEqual(first.data, source); assert.equal(first.pts, 90000);
    const second = unpackTs(mux(pframe, 140, 0x20)); assert.deepEqual(second.data, pframe); assert.equal(second.pts, 93600);
    assert.throws(() => mux(pframe, 139, 0), /AA_MUX_INPUT/);
});

test('capture is armed before video, sorted, keyframe gated and sends only cropped complete pixels', async t => {
    const f = fixture(t);
    assert.equal(f.decoder.args[f.decoder.args.indexOf('-vf') + 1], 'fps=20,crop=1920:560:0:260,scale=1536:448');
    assert.deepEqual([f.ring.width, f.ring.height], [1536, 448]);
    assert.deepEqual(f.capture.args.slice(0, 4), ['--pid', '77', '--starttime', '123456']);
    assert.equal(f.capture.stdin.bytes[0].toString(), 'lease\n');
    assert(!f.messages.some(m => m.status === 'armed'));
    f.capture.stderr.write('{"type":"ar'); f.capture.stderr.write('med"}\n');
    assert(f.messages.some(m => m.status === 'armed'));
    f.capture.stdout.write(record(pframe, 1000)); await delay(60);
    assert.equal(f.decoder.stdin.bytes.length, 0);
    f.capture.stdout.write(Buffer.concat([record(pframe, 1040), record(keyframe(), 1020)])); await delay(70);
    assert.equal(f.player.stats().encoded, 2); assert.equal(f.player.stats().reordered, 1);
    const raw = Buffer.alloc(geometry.width * geometry.height * 3 / 2, 81); f.decoder.stdout.write(raw.slice(0, 77)); assert.equal(f.frames.length, 0);
    f.decoder.stdout.write(raw.slice(77));
    assert.equal(f.frames.length, 1); assert.deepEqual(f.frames[0], raw);
    assert(f.messages.some(m => m.type === 'video' && m.geometry.w === 1920));
    assert(f.messages.some(m => m.status === 'playing'));
    f.player.stop(); assert.equal(f.ring.closed, true);
    f.decoder.stdout.write(raw); assert.equal(f.frames.length, 1);
});

test('fallback decoder keeps the same full-width output and derives I420 boundaries from geometry', t => {
    const f = fixture(t, { nativeCrop: false });
    assert.equal(f.decoder.args[f.decoder.args.indexOf('-vf') + 1], 'fps=20,scale=1536:864');
    assert.deepEqual([f.ring.width, f.ring.height], [1536, 448]);
    const luma = geometry.decodedWidth * geometry.decodedHeight;
    const raw = Buffer.alloc(luma * 3 / 2, 81);
    raw.fill(73, luma, luma * 5 / 4); raw.fill(169, luma * 5 / 4);
    f.decoder.stdout.write(raw.slice(0, raw.length - 1)); assert.equal(f.frames.length, 0);
    f.decoder.stdout.write(raw.slice(-1)); assert.equal(f.frames.length, 1);
    const outputLuma = geometry.width * geometry.height, frame = f.frames[0];
    assert.equal(frame.length, outputLuma * 3 / 2);
    assert.equal(frame[0], 81); assert.equal(frame[outputLuma - 1], 81);
    assert.equal(frame[outputLuma], 73); assert.equal(frame[outputLuma * 5 / 4 - 1], 73);
    assert.equal(frame[outputLuma * 5 / 4], 169); assert.equal(frame[frame.length - 1], 169);
});

test('unknown geometry fails before feeding decoder; recovery retains last image but stops children', async t => {
    const f = fixture(t); f.capture.stdout.write(record(keyframe(1280))); await delay(60);
    assert(f.messages.some(m => m.status === 'error' && m.detail.code === 'video-profile'));
    assert.equal(f.decoder.stdin.bytes.length, 0); assert.equal(f.ring.closed, true);
    const g = fixture(t); g.capture.stderr.write('{"type":"armed"}\n');
    g.capture.stderr.write('{"type":"recovery-needed","code":"frame-too-large","requiredBytes":150000,"maxFrame":262144}\n');
    assert.equal(g.ring.closed, false);
    assert(g.messages.some(m => m.status === 'recovery-needed' && m.detail.requiredBytes === 150000));
    assert(g.capture.stdin.destroyed); assert(g.decoder.stdin.destroyed);
    g.capture.emit('exit', 1); assert(!g.messages.some(m => m.status === 'error'));
});

test('backpressure stops draining encoded frames and a stalled decoder requests one bounded recovery', async t => {
    let clock = 0;
    const f = fixture(t, { now: () => clock });
    f.decoder.stdin.write = b => { f.decoder.stdin.bytes.push(Buffer.from(b)); return false; };
    f.capture.stderr.write('{"type":"armed"}\n');
    f.capture.stdout.write(Buffer.concat([record(keyframe(), 100), record(pframe, 120), record(pframe, 140)]));
    clock = 50; await delay(30);
    assert.equal(f.decoder.stdin.bytes.length, 1);
    clock = 1700; await delay(270);
    assert.equal(f.messages.filter(m => m.status === 'recovery-needed' && m.detail.code === 'decoder-stalled').length, 1);
    f.decoder.stdin.emit('drain'); await delay(20);
    assert.equal(f.decoder.stdin.bytes.length, 1); assert.equal(f.ring.closed, false);
});

test('visible stale frame is retained for recovery but cannot accept touch', t => {
    const c = child(), states = [];
    const p = createAAPlayer({ video() {} }, { forkProcess: () => c });
    t.after(() => { p.stop(); c.kill(); }); p.ready({ video: true }); p.start({ pid: 77 }, state => states.push(state));
    const file = '/dev/shm/mgu-video-bmwlauncher-0123456789abcdef';
    c.emit('message', { type: 'video', file, geometry });
    assert.equal(p.inputPoint({ x: 0, y: 0, w: 960, h: 280 }, 100, 100), null);
    c.emit('message', { type: 'status', status: 'playing' });
    assert(p.inputPoint({ x: 0, y: 0, w: 960, h: 280 }, 100, 100));
    c.emit('message', { type: 'status', status: 'recovery-needed', detail: { code: 'capture-gap' } });
    assert(p.frame()); assert.equal(p.inputPoint({ x: 0, y: 0, w: 960, h: 280 }, 100, 100), null);
    assert.equal(states[states.length - 1], 'recovery-needed');
});

const tallProfile = () => ({ display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580 });
test('confirmed MAIN profiles preserve aspect and map the displayed crop in full-frame coordinates', () => {
    assert.strictEqual(resolveGeometry(), geometry);
    for (const profile of [tallProfile(), { display: 'MAIN', confirmed: true, x: 312, y: 250, w: 1296, h: 580 }]) {
        const selected = resolveGeometry(profile), box = { x: 10, y: 20, w: 960, h: 480 };
        assert(Object.isFrozen(selected)); assert.equal(selected.width, profile.w); assert.equal(selected.height, profile.h);
        const displayed = fitGeometry(box, selected);
        assert(Math.abs(displayed.w / displayed.h - profile.w / profile.h) < 1e-12);
        assert.equal(mapInputPoint(box, displayed.x - 1, displayed.y, false, selected), null);
        assert.deepEqual(mapInputPoint(box, displayed.x, displayed.y, false, selected),
            { x: profile.x, y: profile.y, contentX: 0, contentY: 0 });
        assert.deepEqual(mapInputPoint(box, 1e6, 1e6, true, selected),
            { x: profile.x + profile.w - 1, y: profile.y + profile.h - 1, contentX: profile.w - 1, contentY: profile.h - 1 });
        profile.x = 0; assert.notEqual(selected.x, profile.x, 'caller mutation cannot change the acquired crop');
    }
});

test('geometry rejects unconfirmed/IC, odd, outside, oversized and distorted I420 profiles', () => {
    for (const patch of [{ confirmed: false }, { display: 'IC' }, { x: 377 }, { y: -2 }, { w: 0 }, { h: 581 },
        { x: 1918 }, { y: 600 }, { videoWidth: 1280 }, { videoHeight: 720 }, { width: 2000 },
        { width: 1168, height: 582 }, { height: 580.5 }, { x: NaN }, { w: Infinity }]) {
        assert.throws(() => resolveGeometry(Object.assign(tallProfile(), patch)), /geometry/);
    }
    assert.throws(() => resolveGeometry(null), /unconfirmed/);
    assert.throws(() => resolveGeometry(tallProfile(), false), /native-crop-required/);
    assert.throws(() => createPlayer({ nativeCrop: false, geometryProfile: tallProfile() }, () => {}), /native-crop-required/);
    assert.equal(resolveGeometry(Object.assign(tallProfile(), { width: 584, height: 290 })).width, 584);
});

test('negotiated geometry crops in FFmpeg and publishes only complete matching I420 frames', t => {
    const profile = tallProfile(), f = fixture(t, { geometryProfile: profile });
    profile.w = 4;
    assert.equal(f.decoder.args[f.decoder.args.indexOf('-vf') + 1], 'fps=20,crop=1168:580:376:250,scale=1168:580');
    assert.deepEqual([f.ring.width, f.ring.height], [1168, 580]);
    const raw = Buffer.alloc(1168 * 580 * 3 / 2, 51);
    f.decoder.stdout.write(raw.slice(0, -1)); assert.equal(f.frames.length, 0);
    f.decoder.stdout.write(raw.slice(-1)); assert.deepEqual(f.frames, [raw]);
    assert.deepEqual(f.messages.find(m => m.type === 'video').geometry, resolveGeometry(tallProfile()));
});

test('worker geometry must match the acquired profile and cannot change after the first frame', t => {
    const c = child(), states = [], videos = [], p = createAAPlayer({ video: (id, file) => videos.push(file) }, { forkProcess: () => c });
    t.after(() => { p.stop(); c.kill(); });
    p.ready({ video: true });
    const profile = tallProfile(), expected = resolveGeometry(profile);
    p.start({ pid: 77 }, (state, detail) => states.push([state, detail]), profile);
    profile.x = 0;
    assert.equal(c.messages[0].options.geometryProfile.x, 376);
    const file = '/dev/shm/mgu-video-bmwlauncher-0123456789abcdef';
    c.emit('message', { type: 'video', file, geometry: expected });
    c.emit('message', { type: 'status', status: 'playing' });
    assert(Object.isFrozen(p.frame())); assert(Object.isFrozen(p.frame().geometry));
    assert.deepEqual(p.inputPoint({ x: 0, y: 0, w: 1168, h: 580 }, 0, 0), { x: 376, y: 250, contentX: 0, contentY: 0 });
    c.emit('message', { type: 'video', file, geometry });
    assert.equal(p.frame(), undefined); assert.equal(p.inputPoint({ x: 0, y: 0, w: 1168, h: 580 }, 0, 0), null);
    assert(states.some(s => s[0] === 'error' && s[1].code === 'worker-geometry'));
    assert.deepEqual(videos, [file, null]);
});

test('UI isolates worker generations, rejects foreign paths and cleans late rings after stop', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-player-test-')), children = [], videos = [], states = [];
    t.after(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const p = createAAPlayer({ video: (id, file) => videos.push([id, file]) }, { directory: dir,
        forkProcess() { const c = child(); children.push(c); return c; } });
    t.after(() => { p.stop(); children.forEach(c => c.kill()); });
    p.ready({ video: true }); p.start({ pid: 77 }, (state, detail) => states.push([state, detail]));
    const old = children[0]; p.stop();
    const late = path.join(dir, 'mgu-video-bmwlauncher-0123456789abcdef'); fs.writeFileSync(late, 'ring');
    old.emit('message', { type: 'ring', file: late }); await delay(30); assert(!fs.existsSync(late));
    p.start({ pid: 77 }, (state, detail) => states.push([state, detail])); const current = children[1];
    old.emit('message', { type: 'status', status: 'playing' }); assert(!states.some(s => s[0] === 'playing'));
    current.emit('message', { type: 'video', file: path.join(dir, '..', 'unrelated') });
    assert(states.some(s => s[0] === 'error' && s[1].code === 'worker-ring')); assert.equal(p.frame(), undefined);
});
