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
    c.kill = () => {
        if (c.confirmClose !== false && c.messages.some(m => m.type === 'stop')) c.emit('message', { type: 'closed', ok: true });
        c.exitCode = 0; c.emit('exit', 0); c.emit('close', 0);
    };
    return c;
}
function fixture(t, extra) {
    const children = [], messages = [], frames = [], ring = { file: '/dev/shm/mgu-video-bmwlauncher-0123456789abcdef', closed: false,
        push(b) { frames.push(Buffer.from(b)); }, close() { this.closed = true; } };
    const player = createPlayer(Object.assign({ ffmpeg: 'decoder', capture: 'capture', createRing: (directory, width, height) => { ring.width = width; ring.height = height; return ring; },
        spawnProcess(file, args) { const c = child(); c.file = file; c.args = args; children.push(c); return c; } }, extra), m => messages.push(m));
    player.start({ pid: 77, starttime: '123456', profile: 'mgu21-aa-20261115' });
    t.after(() => { const closing = player.stop(); children.forEach(c => c.kill()); return closing; });
    return { player, children, decoder: children.find(c => c.file === 'decoder'), capture: children.find(c => c.file === 'capture'), messages, frames, ring };
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
    assert.equal(c.messages[0].type, 'arm');
    assert.equal(c.messages[1].type, 'configure');
    assert.equal(c.messages[1].profile.x, 376);
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
    const old = children[0], stopping = p.stop();
    const late = path.join(dir, 'mgu-video-bmwlauncher-0123456789abcdef'); fs.writeFileSync(late, 'ring');
    old.emit('message', { type: 'ring', file: late }); await delay(30); assert(!fs.existsSync(late));
    old.kill(); await stopping;
    p.start({ pid: 77 }, (state, detail) => states.push([state, detail])); const current = children[1];
    old.emit('message', { type: 'status', status: 'playing' }); assert(!states.some(s => s[0] === 'playing'));
    current.emit('message', { type: 'video', file: path.join(dir, '..', 'unrelated') });
    assert(states.some(s => s[0] === 'error' && s[1].code === 'worker-ring')); assert.equal(p.frame(), undefined);
});

function armedFixture(t, extra) {
    const children = [], messages = [], ring = { file: '/dev/shm/mgu-video-bmwlauncher-0123456789abcdef',
        count: 0, closed: false, push() {}, close() { this.closed = true; } };
    const player = createPlayer(Object.assign({ ffmpeg: 'decoder', capture: 'capture',
        createRing() { ring.count++; return ring; },
        spawnProcess(file, args) { const c = child(); c.file = file; c.args = args; children.push(c); return c; }
    }, extra), message => messages.push(message));
    assert.equal(player.arm({ pid: 77, starttime: '123456' }), true);
    t.after(() => { const closing = player.stop(); children.forEach(c => c.kill()); return closing; });
    children[0].stderr.write('{"type":"armed"}\n');
    return { player, children, capture: children[0], messages, ring };
}

test('legacy two-phase capture keeps SPS/PPS and the latest keyframe before allocating a configured decoder', async t => {
    const f = armedFixture(t);
    assert.equal(f.children.length, 1); assert.equal(f.ring.count, 0);
    f.capture.stdout.write(Buffer.concat([record(nal(sps()), 100), record(nal(Buffer.from([0x68, 0xaa])), 110),
        record(nal(Buffer.from([0x65, 0x80, 1])), 120), record(pframe, 130),
        record(nal(Buffer.from([0x65, 0x80, 2])), 140), record(pframe, 150)]));
    await delay(70);
    assert.equal(f.player.stats().warmFrames, 2); assert.equal(f.player.stats().encoded, 0);
    assert.equal(f.children.length, 1); assert.equal(f.ring.count, 0);
    assert.throws(() => f.player.configure(Object.assign(tallProfile(), { confirmed: false })), /unconfirmed/);
    assert.equal(f.children.length, 1); assert.equal(f.ring.count, 0);
    assert.equal(f.player.configure(), true); assert.equal(f.player.configure(), false);
    const decoder = f.children[1];
    assert.equal(decoder.args[decoder.args.indexOf('-vf') + 1], 'fps=20,crop=1920:560:0:260,scale=1536:448');
    assert.equal(f.player.stats().encoded, 2); assert.equal(f.player.stats().warmBytes, 0);
    const payload = unpackTs(Buffer.concat(decoder.stdin.bytes)).data;
    assert.deepEqual(nals(payload).map(unit => unit.type), [7, 8, 5, 1]);
    assert.equal(nals(payload)[2].bytes[nals(payload)[2].bytes.length - 1], 2);
});

test('preconfigure GOP overflow stays bounded, drains capture and resumes from a fresh IDR', async t => {
    let clock = 0;
    const f = armedFixture(t, { now: () => clock });
    f.capture.stdout.write(record(keyframe(), 100)); clock += 50; await delay(30);
    for (let batch = 0; batch < 4; batch++) {
        f.capture.stdout.write(Buffer.concat(Array.from({ length: 40 }, (_, i) => record(pframe, 120 + (batch * 40 + i) * 20))));
        clock += 50; await delay(30);
        assert(f.player.stats().warmFrames <= 128); assert(f.player.stats().warmBytes <= 2 * 1024 * 1024);
    }
    assert.equal(f.player.stats().warmFrames, 0); assert(f.player.stats().preconfigureDropped > 0);
    assert(!f.messages.some(m => m.status === 'error' || m.status === 'recovery-needed'));
    assert.equal(f.player.configure(tallProfile()), true); assert.equal(f.children[1].stdin.bytes.length, 0);
    f.capture.stdout.write(record(nal(Buffer.from([0x65, 0x80, 9])), 4000)); clock += 50; await delay(30);
    assert.equal(f.player.stats().encoded, 1);
    assert.deepEqual(nals(unpackTs(Buffer.concat(f.children[1].stdin.bytes)).data).map(unit => unit.type), [7, 8, 5]);
});

test('stop drains neither late records nor pixels and waits for close of every native child', async t => {
    const f = armedFixture(t);
    f.capture.stdout.write(record(keyframe())); await delay(60);
    f.player.configure(tallProfile());
    let complete = false;
    const closing = f.player.stop().then(() => { complete = true; });
    assert.equal(f.player.stats().warmFrames, 0); assert.equal(f.player.stats().pendingBytes, 0);
    assert.equal(f.player.configure(tallProfile()), false); assert(f.ring.closed);
    f.capture.stdout.write(record(keyframe(), 2000));
    f.capture.emit('exit', 0); await delay(10); assert.equal(complete, false);
    f.capture.kill(); await delay(10); assert.equal(complete, false);
    f.children[1].kill(); await closing; assert.equal(complete, true);
});

test('capture EOF before configure discards retained frames and prevents decoder allocation', async t => {
    const f = armedFixture(t);
    f.capture.stdout.write(record(keyframe())); await delay(60);
    assert.equal(f.player.stats().warmFrames, 1);
    f.capture.stdout.end(); await delay(15);
    assert.equal(f.player.configure(tallProfile()), false); assert.equal(f.ring.count, 0);
    await delay(260); f.capture.kill();
    await f.player.stop();
    assert.equal(f.player.configure(tallProfile()), false); assert.equal(f.children.length, 1);
    assert.equal(f.player.stats().warmBytes, 0);
    assert(f.messages.some(m => m.status === 'error' && m.detail.code === 'capture-eof'));
});

test('preconfigure and first-frame deadlines are independent', async t => {
    let clock = 0;
    const f = armedFixture(t, { now: () => clock });
    clock = 15000; await delay(270);
    assert(!f.messages.some(m => m.status === 'error'));
    f.player.configure(tallProfile()); clock = 25000; await delay(270);
    assert(!f.messages.some(m => m.status === 'error'));
    clock = 27001; await delay(270);
    assert(f.messages.some(m => m.status === 'error' && m.detail.code === 'video-keyframe-timeout'));
});

test('negotiated configure excludes prior GOP, reordered and late pipe records until a post-configure IDR', async t => {
    let clock = 900;
    const f = armedFixture(t, { now: () => clock });
    f.capture.stdout.write(record(keyframe(), 900)); clock = 950; await delay(30);
    assert.equal(f.player.stats().warmFrames, 1);
    f.capture.stdout.write(record(pframe, 950));
    assert(f.player.stats().pendingBytes > 0);
    clock = 1000; assert.equal(f.player.configure(tallProfile()), true);
    const decoder = f.children[1];
    assert.equal(f.player.stats().warmFrames, 0); assert.equal(f.player.stats().pendingBytes, 0);
    assert.equal(decoder.stdin.bytes.length, 0);
    f.capture.stdout.write(Buffer.concat([record(keyframe(), 999), record(keyframe(), 1000), record(pframe, 1001)]));
    clock = 1050; await delay(30);
    assert.equal(decoder.stdin.bytes.length, 0, 'old buffered IDRs and new dependent pictures cannot start the decoder');
    f.capture.stdout.write(Buffer.concat([record(nal(Buffer.from([0x65, 0x80, 9])), 1051), record(pframe, 1052)]));
    clock = 1100; await delay(30);
    assert.equal(f.player.stats().encoded, 2);
    const units = nals(unpackTs(Buffer.concat(decoder.stdin.bytes)).data);
    assert.deepEqual(units.map(unit => unit.type), [7, 8, 5, 1]);
    assert.equal(units[2].bytes[units[2].bytes.length - 1], 9);
});

test('cancel while waiting for a negotiated IDR publishes no stale video or late input', async t => {
    let clock = 900;
    const f = armedFixture(t, { now: () => clock });
    f.capture.stdout.write(record(keyframe(), 900)); clock = 950; await delay(30);
    clock = 1000; f.player.configure(tallProfile());
    const closing = f.player.stop(), decoder = f.children[1];
    f.capture.stdout.write(record(keyframe(), 1100)); clock = 1200; await delay(30);
    assert.equal(decoder.stdin.bytes.length, 0);
    assert(!f.messages.some(m => m.type === 'video' || m.status === 'playing'));
    f.children.forEach(c => c.kill()); await closing;
    assert.equal(f.player.configure(tallProfile()), false); assert(f.ring.closed);
});

test('native SET boundary retains the new IDR received during ACK without decoding the previous GOP', async t => {
    let clock = 900;
    const f = armedFixture(t, { now: () => clock });
    f.capture.stdout.write(record(keyframe(), 900)); clock = 950; await delay(30);
    f.capture.stdout.write(Buffer.concat([record(nal(Buffer.from([0x65, 0x80, 7])), 1100), record(pframe, 1120)]));
    clock = 1200; await delay(30);
    assert.equal(f.player.stats().warmFrames, 2);
    f.capture.stdout.write(record(pframe, 1400));
    clock = 1500;
    assert.equal(f.player.configure(Object.assign(tallProfile(), { setStartedNs: '1000000000' })), true);
    assert.equal(f.player.stats().encoded, 2, 'new IDR captured before ACK is immediately decodable');
    const decoder = f.children[1];
    f.capture.stdout.write(record(keyframe(), 999)); clock = 1550; await delay(30);
    assert.equal(f.player.stats().encoded, 3);
    const units = nals(unpackTs(Buffer.concat(decoder.stdin.bytes)).data);
    assert.deepEqual(units.map(unit => unit.type), [7, 8, 5, 1, 1]);
    assert.equal(units[2].bytes[units[2].bytes.length - 1], 7);
});

test('SET boundary is an exact uint64 and rejects an older GOP even above Number safe precision', async t => {
    let clock = 0;
    const f = armedFixture(t, { now: () => clock });
    for (const setStartedNs of ['0', '-1', '1.5', '18446744073709551616', 1000])
        assert.throws(() => f.player.configure(Object.assign(tallProfile(), { setStartedNs })), /frame-boundary/);
    assert.equal(f.children.length, 1);
    f.player.configure(Object.assign(tallProfile(), { setStartedNs: '9007199254740993' }));
    function exact(low, marker) {
        const b = record(Buffer.concat([nal(sps()), nal(Buffer.from([0x68, 0xaa])), nal(Buffer.from([0x65, 0x80, marker]))]));
        b.writeUInt32LE(low, 8); b.writeUInt32LE(2097152, 12); return b;
    }
    f.capture.stdout.write(Buffer.concat([exact(0, 1), exact(1, 9)])); clock = 50; await delay(30);
    assert.equal(f.player.stats().encoded, 1);
    const units = nals(unpackTs(Buffer.concat(f.children[1].stdin.bytes)).data);
    assert.equal(units[2].bytes[units[2].bytes.length - 1], 9);
});

test('UI transports the attested SET boundary independently of renderer geometry', async t => {
    const c = child(), p = createAAPlayer({ video() {} }, { forkProcess: () => c });
    t.after(() => { const closing = p.stop(); c.kill(); return closing; });
    p.ready({ video: true }); p.arm({ pid: 77 });
    assert.throws(() => p.configure(Object.assign(tallProfile(), { setStartedNs: '0' })), /frame-boundary/);
    assert.equal(c.messages.length, 1);
    assert.equal(p.configure(Object.assign(tallProfile(), { setStartedNs: '9007199254740993' })), true);
    assert.equal(c.messages[1].profile.setStartedNs, '9007199254740993');
    c.emit('message', { type: 'video', file: '/dev/shm/mgu-video-bmwlauncher-0123456789abcdef', geometry: resolveGeometry(tallProfile()) });
    assert.equal(p.frame().geometry.setStartedNs, undefined);
});

test('UI serializes workers and awaits close after the worker confirms native cleanup', async t => {
    const children = [], states = [];
    const p = createAAPlayer({ video() {} }, { forkProcess() { const c = child(); children.push(c); return c; } });
    t.after(() => { const closing = p.stop(); children.forEach(c => c.kill()); return closing; });
    p.ready({ video: true }); assert.equal(p.arm({ pid: 77 }, state => states.push(state)), true);
    assert.equal(children[0].messages.length, 1); assert.equal(children[0].messages[0].type, 'arm');
    assert.throws(() => p.configure({ display: 'IC', confirmed: true }), /unconfirmed/);
    assert.equal(children[0].messages.length, 1);
    assert.equal(p.configure(tallProfile()), true); assert.equal(p.configure(tallProfile()), false);
    const old = children[0], closing = p.stop(); let closed = false; closing.then(() => { closed = true; });
    assert.equal(p.arm({ pid: 78 }, state => states.push(state)), true);
    assert.equal(p.configure(tallProfile()), true); assert.equal(children.length, 1);
    old.emit('message', { type: 'closed', ok: true }); old.emit('exit', 0); await delay(10);
    assert.equal(closed, false); assert.equal(children.length, 1);
    old.emit('close', 0); await closing; await delay(0);
    assert.equal(children.length, 2); assert.deepEqual(children[1].messages.map(m => m.type), ['arm', 'configure']);
    const first = children[1], waiting = p.stop();
    p.arm({ pid: 79 }); const cancelled = p.stop(); first.kill(); await waiting; await cancelled; await delay(0);
    assert.equal(children.length, 2, 'cancelled pending acquisition must not create a worker');
});

test('unconfirmed worker exit rejects cleanup and forbids a replacement capture', async () => {
    const c = child(), states = []; c.confirmClose = false;
    const p = createAAPlayer({ video() {} }, { forkProcess: () => c }); p.ready({ video: true });
    p.arm({ pid: 77 }); const closing = p.stop(); c.kill();
    await assert.rejects(closing, /unconfirmed/);
    assert.equal(p.arm({ pid: 78 }, (state, detail) => states.push([state, detail])), false);
    assert(states.some(value => value[1].code === 'worker-close-unconfirmed'));
});

test('worker exit drains the final capture error before classifying the shutdown', async () => {
    const worker = child(), states = [];
    const player = createAAPlayer({ video() {} }, { forkProcess: () => worker });
    player.ready({ video: true });
    player.arm({ pid: 77 }, (state, detail) => states.push([state, detail]));
    worker.connected = false;
    worker.emit('exit', 1);
    worker.emit('message', { type: 'status', status: 'error', detail: { code: 'capture-prepare', errno: 22 } });
    worker.emit('message', { type: 'closed', ok: false, error: 'capture-close-unconfirmed' });
    worker.emit('close', 1);
    await assert.rejects(player.stop(), /capture-close-unconfirmed/);
    assert.deepEqual(states.filter(([state]) => state === 'error'), [['error', { code: 'capture-prepare', errno: 22 }]]);
});

test('native cleanup errors received during stop reject withdrawal confirmation', async () => {
    const c = child(), player = createPlayer({ capture: 'capture', spawnProcess: () => c }, () => {});
    player.arm({ pid: 77, starttime: '123456' });
    const closing = player.stop();
    c.stderr.write('{"type":"error","code":"guardian-cleanup-pending","errno":16}\n'); c.kill();
    await assert.rejects(closing, /capture-cleanup-pending/);
    await assert.rejects(player.stop(), /capture-cleanup-pending/);
});

test('lost renderer cannot interrupt worker shutdown', async () => {
    const c = child(), p = createAAPlayer({ video() { throw Error('lost layer'); } }, { forkProcess: () => c });
    p.ready({ video: true }); p.arm({ pid: 77 });
    const closing = p.stop(); c.kill(); await closing;
    assert(c.messages.some(m => m.type === 'stop'));
});

test('preconfigure also bounds large frames by bytes rather than only GOP length', async t => {
    let clock = 0;
    const f = armedFixture(t, { now: () => clock });
    f.capture.stdout.write(record(keyframe(), 100)); clock += 50; await delay(30);
    const large = nal(Buffer.alloc(250000, 0x41));
    for (let batch = 0; batch < 3; batch++) {
        f.capture.stdout.write(Buffer.concat(Array.from({ length: 3 }, (_, i) => record(large, 120 + (batch * 3 + i) * 20))));
        clock += 50; await delay(30);
        assert(f.player.stats().warmBytes <= 2 * 1024 * 1024);
    }
    assert(f.player.stats().preconfigureDropped > 0); assert.equal(f.player.stats().warmBytes, 0);
    assert.equal(f.children.length, 1); assert(!f.messages.some(m => m.status === 'recovery-needed' || m.status === 'error'));
});

test('real worker reports unavailable capture closure as uncertain without allocating a decoder', async t => {
    let worker;
    const p = createAAPlayer({ video() {} }, { capture: process.execPath,
        forkProcess(file, args, options) { worker = require('node:child_process').fork(file, args, options); return worker; } });
    t.after(() => { if (worker && worker.exitCode === null) worker.kill('SIGKILL'); });
    p.ready({ video: true }); p.arm({ pid: 77, starttime: '123456' });
    await assert.rejects(p.stop(), /capture-close-unconfirmed/);
    assert.equal(worker.exitCode, 1); assert.equal(p.frame(), undefined);
});

test('capture closure distinguishes cooperative stop, confirmed recovery and forced or unsuccessful exit', async () => {
    for (const result of [{ code: 0, good: true }, { code: 75, terminal: true, good: true },
        { code: 75 }, { code: 1 }, { code: null, signal: 'SIGKILL' }, { code: null, signal: 'SIGSEGV', terminal: true }]) {
        const c = child(), player = createPlayer({ capture: 'capture', spawnProcess: () => c }, () => {});
        player.arm({ pid: 77, starttime: '123456' });
        const closing = player.stop();
        if (result.terminal) c.stderr.write('{"type":"closed","code":"recovery-required","errno":0}\n');
        c.emit('exit', result.code, result.signal); c.emit('close', result.code, result.signal);
        if (result.good) await closing;
        else await assert.rejects(closing, /capture-close-unconfirmed/);
    }
});

test('decoder termination does not replace the capture cooperative-cleanup contract', async t => {
    const f = armedFixture(t); f.player.configure();
    const closing = f.player.stop();
    f.capture.emit('close', 0, null); f.children[1].emit('close', null, 'SIGKILL');
    await closing;
});

test('parent watchdog expires video and touch if a playing worker stops reporting', async t => {
    let clock = 0;
    const c = child(), states = [], p = createAAPlayer({ video() {} }, { forkProcess: () => c, now: () => clock });
    t.after(() => { const closing = p.stop(); c.kill(); return closing; });
    p.ready({ video: true }); p.start({ pid: 77 }, (state, detail) => states.push([state, detail]));
    c.emit('message', { type: 'video', file: '/dev/shm/mgu-video-bmwlauncher-0123456789abcdef', geometry });
    c.emit('message', { type: 'status', status: 'playing' });
    assert(p.inputPoint({ x: 0, y: 0, w: 960, h: 280 }, 100, 100));
    clock = 2400; c.emit('message', { type: 'stats', value: {} }); await delay(260);
    assert(p.frame());
    clock = 4901; await delay(270);
    assert.equal(p.frame(), undefined); assert.equal(p.inputPoint({ x: 0, y: 0, w: 960, h: 280 }, 100, 100), null);
    assert(states.some(s => s[0] === 'error' && s[1].code === 'worker-stale'));
    assert(c.messages.some(m => m.type === 'stop'));
});

test('parent watchdog allows cold startup but bounds a worker that never replies', async t => {
    let clock = 0;
    const c = child(), states = [], p = createAAPlayer({ video() {} }, { forkProcess: () => c, now: () => clock });
    t.after(() => { const closing = p.stop(); c.kill(); return closing; });
    p.ready({ video: true }); p.arm({ pid: 77 }, (state, detail) => states.push([state, detail]));
    clock = 9000; await delay(270); assert(!states.some(s => s[0] === 'error'));
    clock = 10001; await delay(270);
    assert(states.some(s => s[0] === 'error' && s[1].code === 'worker-start-timeout'));
    assert(c.messages.some(m => m.type === 'stop'));
});
