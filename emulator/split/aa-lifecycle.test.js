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

test('AA waits for a fresh context before capture and before focus', async () => {
    const a = fixture(); a.clock(2000); a.api.setVisible(true); await tick();
    assert.equal(a.calls.some(Array.isArray), false); assert.equal(a.api.status().state, 'waiting');
    a.api.context({ state: 1, applet: 1000 }, 1000); await tick();
    assert.equal(a.callbacks.length, 1); await a.api.close();
    const b = fixture(); b.api.setVisible(true); await tick(); b.clock(2000); b.callbacks[0]('armed');
    assert.equal(b.calls.includes('focus'), false); assert.equal(b.api.status().state, 'waiting');
    b.api.context({ state: 1, applet: 50 }, 1000); await tick();
    assert.equal(b.calls.includes('focus'), false);
    b.api.context({ state: 1, applet: 1000 }, 1000); await tick();
    assert.equal(b.calls.filter(c => c === 'focus').length, 1); await b.api.close();
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

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function formatFixture(extra) {
    extra = extra || {};
    const calls = [], callbacks = [], focusCallbacks = [], profiles = [];
    const profile = { display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580, setStartedNs: '12345678901234567' };
    let time = 100, formatError, inputVisible = false;
    const player = {
        ready() {}, frame: () => null, stats: () => null,
        arm(identity, changed) { calls.push('arm'); callbacks.push(changed); assert(Object.isFrozen(identity)); },
        configure(value) { calls.push('configure'); profiles.push(value); return extra.configure !== false; },
        stop() { calls.push('video-stop'); return extra.videoStop && extra.videoStop.promise; }
    };
    const api = createIntegration({}, {
        now: () => time, createPlayer: () => player,
        inspect: async () => ({ pid: 2, starttime: '10', profile: 'mgu21-aa-20261115' }),
        createFocus(applet, changed) {
            calls.push('focus'); focusCallbacks.push(changed);
            if (extra.syncReady) changed({ state: 'ready' });
            return { stop() { calls.push('focus-stop'); return Promise.resolve(); } };
        },
        createFormat(options) {
            calls.push('format-owner'); formatError = options.onError;
            return {
                acquire(identity) {
                    calls.push('format-acquire'); assert(Object.isFrozen(identity));
                    return extra.acquire ? extra.acquire.promise : Promise.resolve();
                },
                geometryProfile() { calls.push('format-profile'); return extra.profile ? extra.profile.promise : Promise.resolve(profile); },
                close() { calls.push('format-close'); return extra.restore ? extra.restore.promise : Promise.resolve(); }
            };
        },
        input: {
            setVisible(value) {
                calls.push('input-' + value); inputVisible = value;
                if (!value && extra.inputStop) return extra.inputStop.promise;
            },
            ready: () => inputVisible, setFocus() {}, close: () => Promise.resolve(), touch: () => true
        }
    });
    api.context({ state: 1, applet: 1000 }, 1000); api.ready({ video: true });
    async function armed() { api.setVisible(true); await tick(); callbacks[0]('armed'); }
    async function ready() { await armed(); if (!extra.syncReady) focusCallbacks[0]({ state: 'ready' }); await tick(); }
    return { api, calls, callbacks, focusCallbacks, profiles, profile, armed, ready,
        clock: value => { time = value; }, lose: code => formatError(code) };
}

test('format acquisition starts only after capture armed and underlay ready, then enables the matching decoder', async () => {
    const f = formatFixture(); await f.armed();
    assert.deepEqual(f.calls, ['arm', 'focus']); assert.equal(f.api.status().inputReady, false);
    f.focusCallbacks[0]({ state: 'ready' }); await tick();
    assert.deepEqual(f.calls, ['arm', 'focus', 'format-owner', 'format-acquire', 'format-profile', 'configure']);
    assert(Object.isFrozen(f.profiles[0])); f.profile.x = 0; assert.equal(f.profiles[0].x, 376);
    assert.equal(f.profiles[0].setStartedNs, '12345678901234567');
    assert.equal(f.api.status().inputReady, false);
    f.callbacks[0]('playing'); assert.equal(f.api.status().inputReady, true);
    await f.api.close();
    assert(f.calls.indexOf('format-close') < f.calls.indexOf('focus-stop'));
});

test('synchronous underlay ready still assigns its release owner before acquiring format', async () => {
    const f = formatFixture({ syncReady: true }); await f.ready();
    assert.equal(f.calls.filter(value => value === 'format-acquire').length, 1);
    f.focusCallbacks[0]({ state: 'ready' }); await tick();
    assert.equal(f.calls.filter(value => value === 'configure').length, 1);
    await f.api.close(); assert.equal(f.calls.filter(value => value === 'focus-stop').length, 1);
});

test('closing MAIN waits for the Android Auto input worker to withdraw', async () => {
    const inputStop = deferred(), f = formatFixture({ inputStop });
    await f.ready(); f.callbacks[0]('playing');
    const closed = f.api.close(); await tick();
    assert(f.calls.includes('format-close'));
    assert.equal(f.calls.includes('focus-stop'), false);
    inputStop.resolve(); await closed;
    assert(f.calls.includes('focus-stop'));
});

test('hiding while acquiring cancels the owner immediately and retains underlay until video and restoration finish', async () => {
    const acquire = deferred(), videoStop = deferred(), restore = deferred();
    const f = formatFixture({ acquire, videoStop, restore }); await f.ready();
    assert(f.calls.includes('format-acquire')); assert.equal(f.calls.includes('configure'), false);
    f.api.setVisible(false);
    assert(f.calls.includes('video-stop')); assert(f.calls.includes('format-close'));
    assert.equal(f.calls.includes('focus-stop'), false);
    acquire.resolve(); await tick(); assert.equal(f.calls.includes('format-profile'), false);
    videoStop.resolve(); await tick(); assert.equal(f.calls.includes('focus-stop'), false);
    restore.resolve(); await tick(); assert(f.calls.includes('focus-stop'));
    assert.equal(f.calls.includes('configure'), false); await f.api.close();
});

test('a late geometry result after hiding cannot configure or enable input', async () => {
    const profile = deferred(), f = formatFixture({ profile }); await f.ready();
    assert(f.calls.includes('format-profile')); f.api.setVisible(false);
    profile.resolve(f.profile); await tick();
    assert.equal(f.calls.includes('configure'), false); assert.equal(f.api.status().inputReady, false);
    assert(f.calls.includes('format-close')); await f.api.close();
});

test('format geometry deadline closes its owner while keeping the underlay for restoration', async () => {
    const profile = deferred(), restore = deferred(), f = formatFixture({ profile, restore }); await f.ready();
    f.clock(4100); profile.resolve(f.profile); await tick();
    assert.equal(f.api.status().detail, 'geometry-timeout');
    assert.equal(f.calls.includes('configure'), false); assert(f.calls.includes('format-close'));
    assert.equal(f.calls.includes('focus-stop'), false);
    restore.resolve(); await tick(); await f.api.close();
});

test('format loss disables input and an unconfirmed restoration blocks further acquisition', async () => {
    const restore = deferred(), f = formatFixture({ restore }); await f.ready(); f.callbacks[0]('playing');
    f.lose('bridge-epoch-changed'); await tick();
    assert.equal(f.api.status().inputReady, false); assert(f.calls.includes('format-close'));
    assert.equal(f.calls.includes('focus-stop'), false);
    restore.reject(Error('restore-unconfirmed')); await tick();
    assert.equal(f.api.status().detail, 'format-restoration-unconfirmed'); assert(f.calls.includes('focus-stop'));
    f.api.setVisible(false); f.api.setVisible(true); await tick();
    assert.equal(f.calls.filter(value => value === 'arm').length, 1);
    assert.equal(f.api.status().detail, 'format-restoration-unconfirmed');
    await assert.rejects(f.api.close(), /format-restoration-unconfirmed/);
});

test('failed capture removal still restores format and releases underlay but blocks a new generation', async () => {
    const videoStop = deferred(), f = formatFixture({ videoStop }); await f.ready(); f.api.setVisible(false);
    videoStop.reject(Error('worker-stop-timeout')); await tick();
    assert(f.calls.includes('format-close')); assert(f.calls.includes('focus-stop'));
    f.api.setVisible(true); await tick();
    assert.equal(f.api.status().detail, 'capture-stop-unconfirmed');
    assert.equal(f.calls.filter(value => value === 'arm').length, 1);
    await assert.rejects(f.api.close(), /capture-stop-unconfirmed/);
});

test('format recovery waits for video withdrawal and observed restoration before acquiring a new owner', async () => {
    const videoStop = deferred(), restore = deferred(), f = formatFixture({ videoStop, restore }); await f.ready();
    f.callbacks[0]('recovery-needed', { requiredBytes: 200000 }); await tick();
    assert.equal(f.api.status().state, 'recovery-needed');
    assert.equal(f.calls.filter(value => value === 'arm').length, 1);
    videoStop.resolve(); await tick();
    assert.equal(f.calls.filter(value => value === 'arm').length, 1);
    restore.resolve(); await tick();
    assert.equal(f.calls.filter(value => value === 'format-acquire').length, 1);
    assert.equal(f.calls.filter(value => value === 'arm').length, 2);
    f.callbacks[1]('armed'); f.focusCallbacks[1]({ state: 'ready' }); await tick();
    assert.equal(f.calls.filter(value => value === 'format-acquire').length, 2); await f.api.close();
});

test('playing cannot enable input before format configuration, and a refused configure closes the owner', async () => {
    const a = formatFixture(); await a.armed(); a.callbacks[0]('playing'); await tick();
    assert.equal(a.api.status().detail, 'geometry-not-configured'); assert.equal(a.api.status().inputReady, false);
    await a.api.close();
    const b = formatFixture({ configure: false }); await b.ready();
    assert.equal(b.api.status().detail, 'geometry-configure'); assert(b.calls.includes('format-close'));
    assert.equal(b.api.status().inputReady, false); await b.api.close();
});

test('an owned format cannot be combined with detached geometry resolvers or confirmations', () => {
    assert.throws(() => fixture({ createFormat: () => {}, resolveGeometryProfile: () => {} }), /format-owner-conflict/);
    assert.throws(() => fixture({ createFormat: true }), /format-owner/);
});

test('owned geometry requires an exact positive uint64 setter boundary before configuring', async () => {
    for (const boundary of [undefined, 12345, '0', '18446744073709551616']) {
        const f = formatFixture(); f.profile.setStartedNs = boundary; await f.ready();
        assert.equal(f.api.status().detail, 'geometry-boundary'); assert.equal(f.calls.includes('configure'), false);
        assert(f.calls.includes('format-close')); await f.api.close();
    }
});

test('a UI hiding during armed notification prevents underlay acquisition', async () => {
    const f = formatFixture();
    f.api.changed(() => { if (f.api.status().state === 'armed') f.api.setVisible(false); });
    f.api.setVisible(true); await tick(); f.callbacks[0]('armed'); await tick();
    assert.equal(f.calls.includes('focus'), false); assert.equal(f.calls.includes('format-acquire'), false);
    await f.api.close();
});

test('a UI hiding during playing notification cannot re-enable input afterwards', async () => {
    const f = formatFixture(); await f.ready();
    f.api.changed(() => { if (f.api.status().state === 'playing') f.api.setVisible(false); });
    f.callbacks[0]('playing'); await tick();
    assert.equal(f.calls.includes('input-true'), false); assert.equal(f.api.status().inputReady, false);
    await f.api.close();
});

test('repeated close shares completion until both capture and input have stopped', async () => {
    const videoStop = deferred(), f = formatFixture({ videoStop }); await f.ready();
    const closing = f.api.close(); assert.equal(f.api.close(), closing);
    let done = false; closing.then(() => { done = true; }); await tick(); assert.equal(done, false);
    videoStop.resolve(); await closing; assert.equal(done, true);
});
