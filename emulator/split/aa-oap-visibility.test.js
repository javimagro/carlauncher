'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { observeLease, age } = require('../../apps/javi_carlauncher/visibility-lease');
const stat = (mtime, values) => Object.assign({ uid: 0, mode: 0o100600, mtime: new Date(mtime), isFile: () => true }, values);

test('external visibility accepts only a fresh root regular file with protected permissions', () => {
    assert.equal(age(stat(1000), 1000), 0);
    assert.equal(age(stat(1000), 1699), 699);
    assert.equal(age(stat(1000), 1700), null);
    assert.equal(age(stat(1001), 1000), null);
    assert.equal(age(stat(1000, { uid: 1000 }), 1000), null);
    assert.equal(age(stat(1000, { mode: 0o100620 }), 1000), null);
    assert.equal(age(stat(1000, { mode: 0o100602 }), 1000), null);
    assert.equal(age(stat(1000, { isFile: () => false }), 1000), null);
    assert.equal(age(stat(NaN), 1000), null);
});
test('visibility expires while stat is delayed and late callbacks cannot reactivate a closed observer', async () => {
    const visible = []; let done, reads = 0;
    const observer = observeLease(value => visible.push(value), { now: () => 1000, lstat(file, cb) { reads++; done = cb; } });
    observer.poll(); assert.equal(reads, 1, 'one asynchronous stat at a time');
    done(null, stat(325)); assert.deepEqual(visible, [true]);
    observer.poll(); assert.equal(reads, 2);
    await delay(45); assert.deepEqual(visible, [true, false], 'old lease expires even while read is pending');
    observer.close(); done(null, stat(1000)); observer.poll();
    assert.deepEqual(visible, [true, false]); assert.equal(reads, 2);
});
test('missing or untrusted leases release external visibility without renewal from OAP', () => {
    const visible = []; let done;
    const observer = observeLease(value => visible.push(value), { now: () => 1000, lstat(file, cb) { done = cb; } });
    done(null, stat(1000)); observer.poll(); done(new Error('ENOENT'));
    observer.poll(); done(null, stat(1000, { uid: 1001 }));
    assert.deepEqual(visible, [true, false]); observer.close();
});
test('a visibility handoff refresh rejects a pre-hide read and accepts only a new valid lease', () => {
    const visible = [], reads = [], replies = [];
    const observer = observeLease(value => visible.push(value), { now: () => 1000, lstat(file, cb) { reads.push(cb); } });
    observer.refresh(value => replies.push(value));
    assert.equal(reads.length, 1, 'refresh never creates overlapping reads');
    reads[0](null, stat(1000)); assert.deepEqual(visible, []); assert.deepEqual(replies, []);
    assert.equal(reads.length, 2); reads[1](null, stat(1000));
    assert.deepEqual(visible, [true]); assert.deepEqual(replies, [true]); observer.close();
});
test('handoff refresh fails closed within 50 ms and rejects late replies after timeout or close', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const visible = [], replies = []; let done;
    const observer = observeLease(value => visible.push(value), { now: () => 1000, lstat(file, cb) { done = cb; } });
    done(new Error('ENOENT'));
    observer.refresh(value => replies.push(value)); t.mock.timers.tick(49); assert.deepEqual(replies, []);
    t.mock.timers.tick(1); assert.deepEqual(replies, [false]);
    done(null, stat(1000)); assert.deepEqual(visible, [], 'timed-out read cannot reactivate external visibility');
    observer.refresh(value => replies.push(value)); observer.close(); done(null, stat(1000));
    assert.deepEqual(replies, [false, false]); assert.deepEqual(visible, []);
});
test('handoff refresh errors release immediately and a successful refresh does not extend lease age', t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    const visible = [], replies = []; let done;
    const observer = observeLease(value => visible.push(value), { now: () => 1000, lstat(file, cb) { done = cb; } });
    done(new Error('ENOENT'));
    observer.refresh(value => replies.push(value)); done(new Error('EACCES'));
    assert.deepEqual(replies, [false]);
    observer.refresh(value => replies.push(value)); done(null, stat(310));
    assert.deepEqual(visible, [true]); t.mock.timers.tick(10); assert.deepEqual(visible, [true, false]);
    assert.deepEqual(replies, [false, true]); observer.close();
});
test('a stat reply arriving after the refresh deadline is rejected even before its timer runs', () => {
    let now = 1000, done; const replies = [], visible = [];
    const observer = observeLease(value => visible.push(value), { now: () => now, lstat(file, cb) { done = cb; } });
    done(new Error('ENOENT')); observer.refresh(value => replies.push(value));
    now = 1050; done(null, stat(1050));
    assert.deepEqual(replies, [false]); assert.deepEqual(visible, []); observer.close();
});
function oapFixture() {
    const calls = [], app = new EventEmitter(), state = new EventEmitter();
    let lease, refresh, leaseClosed = false;
    const entry = { getDescription: () => ({ uuid: 'entry' }), init: async () => {}, setAvailability: async () => {} };
    state.updateResources = async () => {};
    app.rhmiApplication = { getByName: () => state, mapEntryState: async () => {}, openEntryState: async () => {} };
    app.appDescription = { application: { entryPoints: [{ uuid: 'entry' }] } };
    app.getEntryPoints = () => [entry]; app.start = app.initialized = app.destroyBundles = async () => {};
    for (const name of ['registerActive', 'registerInactive', 'registerHmiVisible', 'unregisterHmiVisible']) app[name] = async () => calls.push([name]);
    const report = name => ({ show(on) { calls.push([name, on]); }, close: async () => calls.push([name, 'close']) });
    const stubs = {
        'oap-sdk/src/core/OnlineApp.js': function () { return app; }, 'oap-sdk/src/someip/someipBuilders': {},
        './controller.js': { observe: () => report('controller') }, './telemetria-mgu.js': { report: () => report('telemetry') },
        './navegacion-bmw.js': { report: () => report('navigation') }, './radio-bmw.js': { report: () => report('radio') },
        './audio-bmw-transport.js': { report: () => report('audio') },
        './visibility-lease.js': { observeLease(cb) { lease = cb; return { refresh(done) { refresh = done; }, close() { leaseClosed = true; } }; } }
    };
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../apps/javi_carlauncher/oap.js'), 'utf8'), {
        module, require(name) { if (!(name in stubs)) throw new Error(name); return stubs[name]; },
        console, process: { exit() {} }
    });
    module.exports();
    return { app, state, calls, lease: value => lease(value), refresh(value) { lease(value); const done = refresh; refresh = undefined; done(value); }, leaseClosed: () => leaseClosed };
}
test('OAP external visibility keeps data/input/audio active without claiming real HMI visibility', async () => {
    const f = oapFixture(); f.app.emit('initialized'); await delay(10); f.calls.length = 0;
    f.lease(true); await delay(0);
    for (const name of ['controller', 'telemetry', 'navigation', 'radio', 'audio']) assert(f.calls.some(x => x[0] === name && x[1] === true));
    assert(f.calls.some(x => x[0] === 'registerActive'));
    assert(!f.calls.some(x => x[0] === 'registerHmiVisible'));
    f.state.emit('visible', { visible: true }); await delay(0);
    assert(f.calls.some(x => x[0] === 'registerHmiVisible'));
    f.calls.length = 0; f.app.emit('changeVisibility', { visible: false }); await delay(0);
    assert.deepEqual(f.calls, [['unregisterHmiVisible']], 'real HMI hide does not stop externally visible data streams');
    f.lease(false); await delay(0);
    assert(f.calls.some(x => x[0] === 'registerInactive'));
    for (const name of ['controller', 'telemetry', 'navigation', 'radio', 'audio']) assert(f.calls.some(x => x[0] === name && x[1] === false));
    f.app.emit('shutdown'); await delay(0); assert(f.leaseClosed());
    f.calls.length = 0; f.lease(true); await delay(0); assert.deepEqual(f.calls, []);
});
test('OAP serializes visibility registrations across a slow activation', async () => {
    const f = oapFixture(); f.app.emit('initialized'); await delay(10); f.calls.length = 0;
    let finish;
    f.app.registerActive = () => new Promise(resolve => { f.calls.push(['registerActive']); finish = resolve; });
    f.lease(true); await delay(0); f.lease(false); await delay(0);
    assert(!f.calls.some(x => x[0] === 'registerInactive'));
    finish(); await delay(0);
    assert(f.calls.findIndex(x => x[0] === 'registerInactive') > f.calls.findIndex(x => x[0] === 'registerActive'));
    f.app.emit('shutdown');
});
test('HMI hide between lease creation and its regular poll does not tear down OAP audio or input', async () => {
    const f = oapFixture(); f.app.emit('initialized'); await delay(10);
    f.state.emit('visible', { visible: true }); await delay(0); f.calls.length = 0;
    f.app.emit('changeVisibility', { visible: false }); await delay(0);
    assert.deepEqual(f.calls, [['unregisterHmiVisible']], 'real HMI visibility is withdrawn without waiting for the stat');
    f.refresh(true); await delay(0);
    assert.deepEqual(f.calls, [['unregisterHmiVisible']], 'valid newly created lease keeps all effective services alive');
    f.lease(false); await delay(0);
    for (const name of ['controller', 'telemetry', 'navigation', 'radio', 'audio']) assert(f.calls.some(x => x[0] === name && x[1] === false));
    f.app.emit('shutdown');
});
test('a failed hide refresh stops services and cannot override a later real HMI show', async () => {
    const f = oapFixture(); f.app.emit('initialized'); await delay(10);
    f.state.emit('visible', { visible: true }); await delay(0); f.calls.length = 0;
    f.app.emit('changeVisibility', { visible: false }); f.refresh(false); await delay(0);
    assert(f.calls.some(x => x[0] === 'audio' && x[1] === false));
    f.state.emit('visible', { visible: true }); await delay(0); f.calls.length = 0;
    f.app.emit('changeVisibility', { visible: false }); f.state.emit('visible', { visible: true });
    f.refresh(false); await delay(0);
    assert(!f.calls.some(x => x[0] === 'audio' && x[1] === false)); f.app.emit('shutdown');
});
test('a slow registerActive does not defer withdrawal of actual HMI visibility', async () => {
    const f = oapFixture(); f.app.emit('initialized'); await delay(10);
    let finish; f.app.registerActive = () => new Promise(resolve => { finish = resolve; });
    f.state.emit('visible', { visible: true }); await delay(0);
    f.calls.length = 0; f.app.emit('changeVisibility', { visible: false }); await delay(0);
    assert(f.calls.some(x => x[0] === 'unregisterHmiVisible'));
    f.refresh(false); finish(); await delay(0); f.app.emit('shutdown');
});
