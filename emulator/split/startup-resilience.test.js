'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const { start, report } = require('../../apps/javi_carlauncher/telemetria-mgu');
const { createIntegration } = require('../../native/javi-carlab/aa-integration');
const playAudio = require('../../native/javi-carlab/tdt-audio');
const turn = () => new Promise(resolve => setImmediate(resolve));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
    for (let i = 0; i < 100 && !check(); i++) await delay(5);
    assert(check(), 'expected recovery within the test deadline');
}
function telemetry(t, build, options) {
    const probe = start({ buildTypedProxy(service) {
        if (!service.endsWith('.Vehicle2')) throw Error('unavailable');
        return build();
    } }, setTimeout, clearTimeout, Object.assign({ timeoutMs: 25, retryMs: 5 }, options));
    t.after(() => probe.stop());
    return { probe, speed: () => probe.snapshot().find(r => r.signal === 'statusCarSpeed2') };
}
function vehicle(extra) {
    return Object.assign({ init() {}, waitUntilAvailable() {},
        statusCarSpeed2: { getValue: () => ({ speedVehicleCentreOfGravity: 640 }) }
    }, extra);
}

test('telemetry recovers an initial discovery rejection without reopening the screen', async t => {
    let opens = 0;
    const f = telemetry(t, () => { if (++opens === 1) throw Error('booting'); return vehicle(); });
    await until(() => f.speed().status === 'sample');
    assert.equal(opens, 2); assert.equal(f.speed().fields.speedVehicleCentreOfGravity, 640);
});

test('telemetry retires a hung getter and ignores its late result', async t => {
    let opens = 0, late;
    const lifecycle = [];
    const f = telemetry(t, () => ++opens === 1 ? vehicle({
        statusCarSpeed2: { getValue: () => new Promise(resolve => { late = resolve; }) },
        shutdown() { lifecycle.push('shutdown'); }
    }) : vehicle());
    await until(() => f.speed().status === 'sample');
    assert.deepEqual(lifecycle, ['shutdown']); assert.equal(opens, 2);
    late({ speedVehicleCentreOfGravity: 0 }); await turn();
    assert.equal(f.speed().fields.speedVehicleCentreOfGravity, 640);
});

test('telemetry waits for native shutdown and cancels reconnect when hidden', async t => {
    let opens = 0, finish;
    const f = telemetry(t, () => { opens++; return vehicle({
        waitUntilAvailable: () => new Promise(() => {}),
        shutdown: () => new Promise(resolve => { finish = resolve; })
    }); });
    await until(() => !!finish); await delay(20);
    assert.equal(opens, 1); f.probe.stop(); finish(); await delay(20);
    assert.equal(opens, 1);
});

test('telemetry retries a rejected subscription and removes its eventual handle', async t => {
    let attempts = 0, notify;
    const removed = [];
    const f = telemetry(t, () => vehicle({ statusCarSpeed2: {
        getValue: () => ({ speedVehicleCentreOfGravity: 0 }),
        subscribe(fn) { if (++attempts === 1) throw Error('not ready'); notify = fn; return 0; },
        unsubscribe: id => removed.push(id)
    } }));
    await until(() => !!notify); notify({ speedVehicleCentreOfGravity: 1280 });
    assert.equal(f.speed().fields.speedVehicleCentreOfGravity, 1280);
    f.probe.stop(); await turn(); assert.deepEqual(removed, [0]);
});

test('telemetry does not replace a proxy whose native shutdown failed', async t => {
    let opens = 0, closed = false;
    telemetry(t, () => { opens++; return vehicle({
        waitUntilAvailable: () => Promise.reject(Error('unavailable')),
        shutdown() { closed = true; throw Error('shutdown failed'); }
    }); });
    await until(() => closed); await delay(30); assert.equal(opens, 1);
});

test('a timed-out telemetry subscription releases its late handle without accepting old events', async t => {
    let opens = 0, complete, notify;
    const removed = [];
    const f = telemetry(t, () => ++opens === 1 ? vehicle({ statusCarSpeed2: {
        getValue: () => new Promise(() => {}),
        subscribe(fn) { notify = fn; return new Promise(resolve => { complete = resolve; }); },
        unsubscribe(id) { removed.push(id); }
    } }) : vehicle());
    await until(() => f.speed().status === 'sample');
    complete(7); notify({ speedVehicleCentreOfGravity: 0 }); await turn();
    assert.deepEqual(removed, [7]); assert.equal(f.speed().fields.speedVehicleCentreOfGravity, 640);
});

test('a telemetry proxy built after its deadline is closed and cannot publish', async t => {
    let opens = 0, late, disposed = 0;
    const f = telemetry(t, () => ++opens === 1 ? new Promise(resolve => { late = resolve; }) : vehicle());
    await until(() => f.speed().status === 'sample');
    late(vehicle({ shutdown() { disposed++; }, init() { assert.fail('expired proxy initialized'); } }));
    await turn(); assert.equal(disposed, 1); assert.equal(opens, 2);
});

test('hiding and immediately reopening telemetry waits for the previous SDK shutdown', async t => {
    let opens = 0, finish;
    const client = report({ buildTypedProxy(service) {
        if (!service.endsWith('.Vehicle2')) throw Error('unavailable');
        opens++;
        return vehicle({ shutdown: () => new Promise(resolve => { finish = resolve; }) });
    } }, { host: '127.0.0.1', port: 1 });
    t.after(() => { client.show(false); if (finish) finish(); });
    client.show(true); await until(() => opens === 1);
    client.show(false); client.show(true); await until(() => !!finish);
    await delay(20); assert.equal(opens, 1);
    finish(); await until(() => opens === 2);
});

function aa(t, extra) {
    let time = 0, captures = 0, focuses = 0, callback;
    const api = createIntegration({}, Object.assign({ now: () => time, contextWaitMs: 30,
        inspect: async () => ({ pid: 2, starttime: '10' }),
        createPlayer: () => ({ ready() {}, stop() {},
            start(identity, changed) { captures++; callback = changed; } }),
        createFocus() { focuses++; return { stop() {} }; }
    }, extra));
    t.after(() => api.close());
    api.context({ state: 1, applet: 1000 }, 1000); api.ready({ video: true });
    return { api, clock: n => { time = n; }, captures: () => captures, focuses: () => focuses,
        armed: () => callback('armed') };
}

test('AA resumes after a slow identity check receives a fresh HMI context', async t => {
    let resolve;
    const f = aa(t, { inspect: () => new Promise(done => { resolve = done; }) });
    f.api.setVisible(true); await turn(); f.clock(2000);
    resolve({ pid: 2, starttime: '10' }); await turn();
    assert.equal(f.api.status().state, 'waiting'); assert.equal(f.captures(), 0);
    f.api.context({ state: 1, applet: 1000 }, 1000); await turn();
    assert.equal(f.captures(), 1); f.armed(); assert.equal(f.focuses(), 1);
});

test('AA hiding cancels a context wait and late updates cannot acquire focus', async t => {
    const f = aa(t); f.api.setVisible(true); await turn(); f.clock(2000); f.armed();
    f.api.setVisible(false); f.api.context({ state: 1, applet: 1000 }, 1000); await turn();
    assert.equal(f.focuses(), 0); assert.equal(f.api.status().state, 'unavailable');
});

test('AA context wait expires without acquiring or retrying focus', async t => {
    const f = aa(t); f.api.setVisible(true); await turn(); f.clock(2000); f.armed();
    await until(() => f.api.status().state === 'error');
    f.api.context({ state: 1, applet: 1000 }, 1000); await turn();
    assert.equal(f.captures(), 1); assert.equal(f.focuses(), 0);
});

function audio(t, options) {
    const pcm = new PassThrough(), peers = [], writes = [];
    const output = playAudio(pcm, () => {}, null, Object.assign({ retryMs: 5 }, options), () => {
        const peer = new EventEmitter(); peer.stdin = new EventEmitter();
        peer.stdout = new PassThrough(); peer.stderr = new PassThrough(); peer.kill = () => {};
        peer.stdin.write = bytes => { writes.push(Buffer.from(bytes)); return false; };
        peer.stdin.end = () => { peer.ended = true; };
        peers.push(peer); return peer;
    }, { warn() {} });
    t.after(() => output.close()); return { pcm, peers, writes, output };
}

test('short PCM backpressure preserves every sample and its ordering', t => {
    const f = audio(t), bytes = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    f.pcm.write(bytes.slice(0, 8)); f.pcm.write(bytes.slice(8, 20)); f.pcm.write(bytes.slice(20));
    f.peers[0].stdin.emit('drain'); f.peers[0].stdin.emit('drain');
    assert.deepEqual(Buffer.concat(f.writes), bytes);
    assert.equal(f.output.stats().droppedBytes, 0); assert.equal(f.output.stats().pendingBytes, 0);
});

test('PCM queue overflow replaces only audio and never splices a later block onto the gap', async t => {
    const f = audio(t);
    f.pcm.write(Buffer.alloc(9600, 1)); f.pcm.write(Buffer.alloc(19200, 2)); f.pcm.write(Buffer.alloc(4, 3));
    assert.equal(f.output.stats().failures, 1); assert.equal(f.output.stats().pendingBytes, 0);
    await until(() => f.peers.length === 2);
    f.peers[0].stdin.emit('drain'); f.pcm.write(Buffer.alloc(4, 4));
    assert.deepEqual(f.writes, [Buffer.alloc(9600, 1), Buffer.alloc(4, 4)]);
    const s = f.output.stats(); assert.equal(s.receivedBytes, s.submittedBytes + s.droppedBytes);
    assert.equal(f.pcm.isPaused(), false);
});

test('closing PCM drops pending bytes and cannot flush them after a stale drain event', t => {
    const f = audio(t); f.pcm.write(Buffer.alloc(4)); f.pcm.write(Buffer.alloc(8));
    f.output.close(); f.peers[0].stdin.emit('drain');
    assert.equal(f.writes.length, 1); assert.equal(f.output.stats().pendingBytes, 0);
    assert.equal(f.output.stats().droppedBytes, 8);
});

test('audio EOF flushes pending PCM before closing the pipe', t => {
    const f = audio(t); f.pcm.write(Buffer.alloc(4)); f.pcm.write(Buffer.alloc(8));
    let finished = false; f.output.drain(() => { finished = true; });
    assert.equal(f.peers[0].ended, undefined);
    f.peers[0].stdin.emit('drain'); assert.equal(f.peers[0].ended, true);
    f.peers[0].emit('close', 0); assert.equal(finished, true);
    assert.equal(f.output.stats().droppedBytes, 0);
});

test('a late focus confirmation cannot reopen PCM after focus was lost', async t => {
    let accept, lose;
    const f = audio(t, { bmwFocus: true, createFocus(lost) {
        lose = lost; return { start: () => new Promise(resolve => { accept = resolve; }), close() {} };
    } });
    f.pcm.write(Buffer.alloc(4)); lose('lost'); accept(); await turn();
    assert.equal(f.peers.length, 0); assert.equal(f.pcm.isPaused(), false);
});
