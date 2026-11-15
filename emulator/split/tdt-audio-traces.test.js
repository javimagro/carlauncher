'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../../tools/tdt-runtime/Analizar-Audio-TDT');
test('offline audio diagnosis measures each helper separately and redacts unrelated trace data', () => {
    const text = [
        'URL https://example.com/?token=secret',
        'PCM t=1000 frames=36000 eagain=100 recover=0 state=3 avail=160',
        'PCM t=11000 frames=396000 eagain=1100 recover=0 state=3 avail=160',
        JSON.stringify({ stats: { presented: 200, fps: 20, password: 'secret', audio: { droppedBytes: 1000, token: 'secret' } } }),
        'PCM t=1000 frames=47400 eagain=10 recover=0 state=3 avail=160',
        'PCM t=11000 frames=521400 eagain=20 recover=0 state=3 avail=160'
    ].join('\n');
    const r = analyze(text);
    assert.equal(r.native.length, 2);
    assert.deepEqual(r.native.map((n) => n.acceptedFramesPerSecond), [36000, 47400]);
    assert.equal(r.insufficientPcmAcceptance, true);
    assert.equal(r.sinkDiscardedPcm, true);
    assert.equal(r.queueDiscardedPcm, null);
    assert(!JSON.stringify(r).includes('secret'));
});
test('missing samples never become a zero audio rate or evidence of working sound', () => {
    const r = analyze('PCM t=1000 frames=0 eagain=0 recover=0\n{"stats":null}\n{"sink":"bad"}');
    assert.equal(r.native[0].acceptedFramesPerSecond, null);
    assert.equal(r.insufficientPcmAcceptance, null);
    assert.equal(r.sinkDiscardedPcm, null);
    assert.equal(r.video, null);
    assert.equal(r.pcmQueue, null);
});
