'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { readContext, restoreFocus } = require('../../native/javi-carlab/aa-context');
const { createIntegration } = require('../../native/javi-carlab/aa-integration');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('AA context reader is bounded and kills only its own hmictl child after the reply', async () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
    const killed = []; child.kill = signal => killed.push(signal);
    let args;
    const pending = readContext({ spawn: (file, argv) => { args = argv; return child; } });
    child.stdout.write('startup\nok 1 50 0 0'); child.stdout.write(' 1\n');
    assert.deepEqual(await pending, { state: 1, applet: 50 });
    assert.deepEqual(args, ['serve']); assert.deepEqual(killed, ['SIGKILL']);
});

test('AA restoration preserves original AA and never guesses a missing HMI context', async () => {
    let restored = 0; const session = { focusNative: async () => { restored++; } };
    assert.equal(await restoreFocus(session, async () => ({ state: 1, applet: 50 }), true), 'native-aa-retained');
    assert.equal(await restoreFocus(session, async () => null, true), 'context-unavailable');
    assert.equal(await restoreFocus(session, async () => { throw Error('unused'); }, false), 'not-acquired');
    assert.equal(restored, 0);
    assert.equal(await restoreFocus(session, async () => ({ state: 1, applet: 1000 }), true), 'restored');
    assert.equal(restored, 1);
});

function fixture(extra) {
    const calls = [], callbacks = [], profiles = []; let time = 100, release;
    const player = { ready() {}, stop() { calls.push('stop'); }, frame: () => null, stats: () => null,
        start(identity, changed, profile) { calls.push(['start', identity.initialBytes]); callbacks.push(changed); profiles.push(profile); } };
    const api = createIntegration({}, Object.assign({ capture: 'test', now: () => time, createPlayer: () => player,
        inspect: async () => ({ pid: 2, starttime: '10', profile: 'mgu21-aa-20261115' }),
        createFocus() { calls.push('focus'); return { stop() { calls.push('release'); return release || Promise.resolve(); } }; }
    }, extra));
    api.context({ state: 1, applet: 1000 }, 1000); api.ready({ video: true });
    return { api, calls, callbacks, profiles, clock: value => { time = value; }, release: promise => { release = promise; } };
}

test('AA late identity response cannot capture or acquire after hiding', async () => {
    let reply; const f = fixture({ inspect: () => new Promise(resolve => { reply = resolve; }) });
    f.api.setVisible(true); await tick(); f.api.setVisible(false);
    reply({ pid: 2, starttime: '10' }); await tick();
    assert.equal(f.calls.some(c => Array.isArray(c)), false);
    assert.equal(f.calls.includes('focus'), false); await f.api.close();
});

test('AA resolves a fresh immutable geometry confirmation for every acquisition and recovery', async () => {
    const epochs = [], pending = [];
    const f = fixture({ resolveGeometryProfile: (identity, epoch) => {
        assert(Object.isFrozen(identity)); epochs.push(epoch);
        return new Promise(resolve => pending.push(resolve));
    } });
    f.api.setVisible(true); await tick(); assert.equal(f.callbacks.length, 0);
    const profile = { display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580 };
    pending[0](profile); await tick(); profile.x = 0;
    assert.equal(f.profiles[0].x, 376); assert(Object.isFrozen(f.profiles[0]));
    f.callbacks[0]('recovery-needed', {}); await tick(); assert.equal(f.callbacks.length, 1);
    pending[1]({ display: 'MAIN', confirmed: true, x: 312, y: 250, w: 1296, h: 580 }); await tick();
    assert.deepEqual(epochs, [1, 2]); assert.equal(f.profiles[1].w, 1296);
    await f.api.close();
});

test('AA ignores late geometry ACK after hiding and rejects an unconfirmed next acquisition', async () => {
    const pending = [], f = fixture({ resolveGeometryProfile: () => new Promise(resolve => pending.push(resolve)) });
    f.api.setVisible(true); await tick(); f.api.setVisible(false);
    pending[0]({ display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580 }); await tick();
    assert.equal(f.callbacks.length, 0);
    f.api.setVisible(true); await tick();
    pending[1]({ display: 'MAIN', confirmed: false, x: 376, y: 250, w: 1168, h: 580 }); await tick();
    assert.equal(f.callbacks.length, 0); assert.equal(f.api.status().detail, 'geometry-unconfirmed');
    await f.api.close();
});

test('AA rejects a geometry ACK after its deadline even before the timer callback runs', async () => {
    let reply;
    const f = fixture({ resolveGeometryProfile: () => new Promise(resolve => { reply = resolve; }) });
    f.api.setVisible(true); await tick(); f.clock(4100);
    reply({ display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580 }); await tick();
    assert.equal(f.callbacks.length, 0); assert.equal(f.api.status().detail, 'geometry-timeout');
    await f.api.close();
});

test('a one-acquisition geometry confirmation cannot silently survive recovery', async () => {
    const profile = { display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580 };
    const f = fixture({ geometryProfile: profile }); profile.w = 4;
    f.api.setVisible(true); await tick(); assert.equal(f.profiles[0].w, 1168);
    f.callbacks[0]('recovery-needed', {}); await tick();
    assert.equal(f.callbacks.length, 1); assert.equal(f.api.status().detail, 'geometry-confirmation-required');
    await f.api.close();
    assert.throws(() => fixture({ geometryProfile: { display: 'IC', confirmed: true } }), /geometry-unconfirmed/);
});

test('AA arms capture before acquiring MAIN focus and never enables unverified input', async () => {
    const f = fixture(); f.api.setVisible(true); await tick();
    assert.deepEqual(f.calls, [['start', 122880]]);
    f.callbacks[0]('armed'); assert.equal(f.calls[1], 'focus');
    f.callbacks[0]('playing'); assert.deepEqual(f.api.status(), { state: 'playing', inputReady: false, detail: undefined });
    assert.equal(f.api.touch('down', { x: 50, y: 300 }), false);
    f.api.setVisible(false); await tick();
    f.callbacks[0]('armed'); assert.equal(f.calls.filter(c => c === 'focus').length, 1);
    await f.api.close();
});

test('AA recovery waits for focus release before restarting and is bounded', async () => {
    const f = fixture(); f.api.setVisible(true); await tick(); f.callbacks[0]('armed');
    let release; f.release(new Promise(resolve => { release = resolve; }));
    f.callbacks[0]('recovery-needed', { requiredBytes: 130000 }); await tick();
    assert.equal(f.callbacks.length, 1); release(); await tick();
    assert.deepEqual(f.calls.filter(Array.isArray), [['start', 122880], ['start', 245760]]);
    f.callbacks[1]('recovery-needed', {}); await tick();
    f.callbacks[2]('recovery-needed', {}); await tick();
    assert.equal(f.callbacks.length, 3); assert.equal(f.api.status().detail, 'recovery-exhausted');
    await f.api.close();
});

test('AA refuses stale contexts before capture and before focus', async () => {
    const a = fixture(); a.clock(2000); a.api.setVisible(true); await tick();
    assert.equal(a.calls.some(Array.isArray), false); assert.equal(a.api.status().state, 'error'); await a.api.close();
    const b = fixture(); b.api.setVisible(true); await tick(); b.clock(2000); b.callbacks[0]('armed');
    assert.equal(b.calls.includes('focus'), false); assert.equal(b.api.status().detail, 'context-changed'); await b.api.close();
});

test('AA waits for loaded input support and starts only when its requirements become ready', async () => {
    let missing = 'aa-gate-restart-required';
    const f = fixture({ requirement: () => missing });
    f.api.setVisible(true); await tick();
    assert.equal(f.api.status().state, 'waiting');
    assert.equal(f.api.status().detail, missing);
    assert.equal(f.callbacks.length, 0);
    missing = null;
    f.api.context({ state: 1, applet: 1000 }, 1000); await tick();
    assert.equal(f.callbacks.length, 1);
    missing = 'aa-controls-unavailable';
    f.callbacks[0]('armed'); await tick();
    assert.equal(f.calls.includes('focus'), false);
    assert.equal(f.api.status().detail, missing);
    f.api.context({ state: 1, applet: 1000 }, 1000); await tick();
    assert.equal(f.callbacks.length, 1, 'a failed acquisition does not retry indefinitely');
    await f.api.close();
});
