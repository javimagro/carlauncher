'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { setTimeout: delay } = require('node:timers/promises');
const playAudio = require('../../native/javi-carlab/tdt-audio');
const { createPcmQueue } = require('../../native/javi-carlab/tdt-player');

test('PCM accounting preserves stereo frames across odd chunks and distinguishes losses', () => {
    const q = createPcmQueue(16), data = Buffer.from(Array.from({ length: 32 }, (_, i) => i));
    q.push(data.slice(0, 3)); q.push(data.slice(3, 12));
    const out = Buffer.alloc(8);
    assert(q.take(8, out)); assert.deepEqual(out, data.slice(0, 8));
    q.push(data.slice(12, 31)); // 23 queued bytes -> discard 8, retaining frame alignment.
    assert(q.take(4)); // Explicit video-clock skip is not an overflow.
    assert.equal(q.take(16, Buffer.alloc(16)), false);
    q.push(data.slice(31));
    assert(q.take(8, out)); assert.deepEqual(out, data.slice(20, 28));
    const s = q.stats();
    assert.deepEqual(s, { receivedBytes: 32, deliveredBytes: 16, overflowBytes: 8,
        skippedBytes: 4, emptyReads: 1, queuedBytes: 4 });
    assert.equal(s.receivedBytes, s.deliveredBytes + s.overflowBytes + s.skippedBytes + s.queuedBytes);
});

test('audio preserves PCM during short backpressure and accounts readiness drops', () => {
    const pcm = new PassThrough(), peer = new EventEmitter(), writes = [];
    peer.stdin = new EventEmitter(); peer.stdout = new PassThrough(); peer.stderr = new PassThrough(); peer.kill = () => {};
    peer.stdin.write = (bytes) => { writes.push(Buffer.from(bytes)); return false; };
    const output = playAudio(pcm, () => {}, null, { handshake: true }, () => peer, { warn() {} });
    try {
        pcm.write(Buffer.alloc(4, 1)); peer.stdout.write('ready\n');
        pcm.write(Buffer.alloc(8, 2)); pcm.write(Buffer.alloc(12, 3));
        assert.deepEqual(writes, [Buffer.alloc(8, 2)]);
        const s = output.stats();
        assert.equal(s.receivedBytes, s.submittedBytes + s.droppedBytes + s.pendingBytes);
        assert.equal(s.notReadyBytes, 4); assert.equal(s.blockedBytes, 0);
        assert.equal(s.pendingBytes, 12);
        peer.stdin.emit('drain');
        assert.deepEqual(writes, [Buffer.alloc(8, 2), Buffer.alloc(12, 3)]);
        assert.equal(output.stats().pendingBytes, 0);
        assert.equal(s.droppedBytes, s.notReadyBytes + s.blockedBytes);
    } finally { output.close(); }
});

test('synchronous audio launch failures have bounded retries while PCM keeps draining', async (t) => {
    const pcm = new PassThrough(); let launches = 0;
    const output = playAudio(pcm, () => {}, null, { retryMs: 5, maxRetries: 1 },
        () => { launches++; throw new Error('launch unavailable'); }, { warn() {} });
    t.after(() => output.close());
    for (let n = 0; n < 20; n++) pcm.write(Buffer.alloc(4));
    await delay(30);
    for (let n = 0; n < 20; n++) pcm.write(Buffer.alloc(4));
    assert.equal(launches, 2);
    assert.equal(output.stats().failures, 2);
    assert.equal(pcm.isPaused(), false);
});

test('closing audio from a failure callback cancels any retry', async () => {
    const pcm = new PassThrough(); let launches = 0, output;
    const peer = new EventEmitter();
    peer.stdin = new PassThrough(); peer.stderr = new PassThrough(); peer.kill = () => {};
    output = playAudio(pcm, (state) => { if (state === 'audio-stall') output.close(); }, null,
        { retryMs: 5 }, () => { launches++; return peer; }, { warn() {} });
    pcm.write(Buffer.alloc(4)); peer.emit('close', 8);
    await delay(20);
    assert.equal(launches, 1);
});
