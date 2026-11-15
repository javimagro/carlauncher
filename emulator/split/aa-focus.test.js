'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { createFocus } = require('../../native/javi-carlab/aa-focus');
const { run } = require('../../native/javi-carlab/aa-focus-process');
const { createLock } = require('../../native/javi-carlab/aa-focus-lock');
const flush = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function clock() {
    let at = 0, serial = 0;
    const jobs = new Map(), frozen = new Set();
    function add(fn, delay, owner, repeat) {
        const id = ++serial; jobs.set(id, { fn, due: at + delay, delay, owner, repeat }); return id;
    }
    return {
        now: () => at, frozen,
        cancel: id => jobs.delete(id),
        kill(owner) { for (const [id, job] of jobs) if (job.owner === owner) jobs.delete(id); },
        timers(owner) { return {
            now: () => at,
            setTimeout: (fn, ms) => add(fn, ms, owner, false), clearTimeout: id => jobs.delete(id),
            setInterval: (fn, ms) => add(fn, ms, owner, true), clearInterval: id => jobs.delete(id),
            wait: ms => new Promise(resolve => add(resolve, ms, owner, false))
        }; },
        async tick(ms) {
            const end = at + ms;
            for (let count = 0; count < 5000; count++) {
                let selected;
                for (const [id, job] of jobs) if (job.due <= end && (!selected || job.due < selected[1].due)) selected = [id, job];
                if (!selected) { at = end; await flush(); return; }
                const [id, job] = selected; at = job.due;
                if (frozen.has(job.owner)) { job.due += Math.max(job.delay, 1); continue; }
                if (job.repeat) job.due += job.delay; else jobs.delete(id);
                job.fn(); await flush();
            }
            throw new Error('timer loop');
        }
    };
}
function child(pid) {
    const result = new EventEmitter();
    result.pid = pid; result.connected = true; result.exitCode = null; result.sent = []; result.signals = [];
    result.send = (message, callback) => { result.sent.push(message); if (callback) callback(); };
    result.kill = signal => { result.signals.push(signal); return true; };
    return result;
}
function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-focus-test-'));
    t.after(() => {
        assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return path.join(root, 'lock');
}

test('focus stop has external TERM/KILL/deadline even with a frozen supervisor', async () => {
    const time = clock(), process = child(101);
    const focus = createFocus(42, () => {}, Object.assign({ fork: () => process }, time.timers(0)));
    const stopped = focus.stop(); const rejected = assert.rejects(stopped, /focus-stop-timeout/);
    await time.tick(10000); assert.deepEqual(process.signals, ['SIGTERM']);
    await time.tick(3000); assert.deepEqual(process.signals, ['SIGTERM', 'SIGKILL']);
    await time.tick(1000); await rejected;
});

test('focus stop retains failed restoration messages and rejects a failing exit', async () => {
    const time = clock(), process = child(101);
    const focus = createFocus(42, () => {}, Object.assign({ fork: () => process }, time.timers(0)));
    const stopped = focus.stop(); const rejected = assert.rejects(stopped, /focus-restore-unconfirmed/);
    process.emit('message', { state: 'closed', restoration: 'restore-failed', safe: false });
    process.exitCode = 2; process.emit('exit', 2); process.emit('close', 2); await rejected;
});

test('a bare supervisor exit is not proof that the orphan owner restored focus', async () => {
    const time = clock(), process = child(101);
    const focus = createFocus(42, () => {}, Object.assign({ fork: () => process }, time.timers(0)));
    process.exitCode = null; process.emit('exit', null, 'SIGKILL'); process.emit('close', null, 'SIGKILL');
    await assert.rejects(focus.stop(), /focus-restore-unconfirmed/);
});

test('exclusive focus lock never steals a dead/unknown session and checks both identities', t => {
    const directory = temporary(t), living = new Map([[101, '11'], [202, '22'], [303, '33']]);
    const identity = pid => living.has(pid) ? { pid, starttime: living.get(pid) } : null;
    const make = pid => createLock({ directory, pid, identity });
    const supervisor = make(101), token = supervisor.acquire(), owner = make(202);
    assert.deepEqual(owner.join(token), { pid: 202, starttime: '22' });
    supervisor.register({ pid: 202, starttime: '22' }); supervisor.authorize();
    assert.equal(owner.verify('owner').attempted, true);
    assert.equal(owner.release('owner'), false);
    assert.equal(supervisor.release('supervisor'), false);
    assert.throws(() => make(303).acquire(), /focus-locked/);
    living.delete(101); living.delete(202);
    assert.throws(() => make(303).acquire(), /focus-locked/);
    // Only the recorded owner can finish this session, after confirming restore.
    living.set(202, '22'); assert.equal(owner.release('owner'), true);
    const next = make(303); next.acquire(); assert.equal(next.release('supervisor'), true);
});

test('final restoration proof arriving after exit is consumed before close', async () => {
    const time = clock(), process = child(101);
    const focus = createFocus(42, () => {}, Object.assign({ fork: () => process }, time.timers(0)));
    const stopped = focus.stop(); process.exitCode = 0; process.emit('exit', 0);
    process.emit('message', { state: 'closed', restoration: 'restored', safe: true });
    process.emit('close', 0); assert.equal((await stopped).restoration, 'restored');
});

test('spawn failure without a PID rejects without waiting for signal deadlines', async () => {
    const time = clock(), process = child(undefined);
    const focus = createFocus(42, () => {}, Object.assign({ fork: () => process }, time.timers(0)));
    process.emit('error', new Error('spawn failed'));
    await assert.rejects(focus.stop(), /focus-start/);
    assert.deepEqual(process.signals, []);
});

function scenario(t, configuration) {
    configuration = configuration || {};
    const directory = temporary(t), time = clock(), living = new Map(), processes = new Map();
    const events = [], changes = [];
    let selectedContext = { state: 1, applet: configuration.contextApplet || 42 };
    let restoreContext;
    const identity = pid => living.has(pid) ? { pid, starttime: living.get(pid) } : null;
    function launch(pid, parent, args, asOwner) {
        const handle = child(pid), proc = new EventEmitter();
        living.set(pid, String(pid * 10)); proc.pid = pid; proc.ppid = parent;
        proc.connected = true; proc.argv = ['node', 'aa-focus-process.js'].concat(args);
        processes.set(pid, { proc, handle });
        proc.send = (message, callback) => {
            if (proc.connected) Promise.resolve().then(() => { if (!time.frozen.has(parent)) handle.emit('message', message); });
            if (callback) callback();
        };
        handle.send = (message, callback) => {
            handle.sent.push(message);
            Promise.resolve().then(() => { if (proc.connected && !time.frozen.has(pid)) proc.emit('message', message); });
            if (callback) callback();
        };
        proc.exit = code => {
            if (!living.has(pid)) return;
            living.delete(pid); time.kill(pid); proc.connected = handle.connected = false; handle.exitCode = code;
            for (const value of processes.values()) if (value.proc.ppid === pid && value.proc.connected) {
                value.proc.connected = value.handle.connected = false;
                Promise.resolve().then(() => value.proc.emit('disconnect'));
            }
            Promise.resolve().then(() => { if (!time.frozen.has(parent)) { handle.emit('exit', code); handle.emit('close', code); } });
        };
        handle.kill = signal => {
            handle.signals.push(signal);
            if (signal === 'SIGKILL') proc.exit(null);
            else if (!time.frozen.has(pid)) proc.emit(signal);
            return true;
        };
        const session = {
            connect: () => Promise.resolve(), close: () => Promise.resolve(),
            focusProjected: () => {
                events.push('projected:' + pid);
                return configuration.pendingAcquire ? configuration.pendingAcquire.promise : Promise.resolve(true);
            },
            focusNative: () => {
                events.push('native:' + pid);
                return configuration.failRestore ? Promise.reject(new Error('failed')) : Promise.resolve(true);
            }
        };
        const context = () => {
            if (configuration.deferOrphanContext && asOwner && !proc.connected) {
                restoreContext = deferred(); return restoreContext.promise;
            }
            return Promise.resolve(selectedContext);
        };
        Promise.resolve().then(() => run(42, asOwner, Object.assign({}, time.timers(pid), {
            process: proc, session, readContext: context, token: args[2],
            lock: createLock({ directory, pid, identity }),
            fork: (file, nextArgs) => launch(202, pid, nextArgs, true)
        }))).catch(error => { events.push('run-error:' + error.message); });
        return handle;
    }
    const focus = createFocus(42, message => changes.push(message), Object.assign({}, time.timers(0), {
        fork: (file, args) => launch(101, 0, args, false)
    }));
    return { focus, events, changes, time, directory, processes, identity,
        context: value => { selectedContext = value; },
        restore: () => restoreContext,
        competitor: () => { living.set(303, '3030'); return createLock({ directory, pid: 303, identity }); } };
}

test('handshake registers owner before PROJECTED and normal stop confirms lock removal', async t => {
    const s = scenario(t); await flush(); await flush();
    assert.deepEqual(s.events, ['projected:202']);
    assert.ok(s.changes.some(value => value.state === 'ready'));
    const record = JSON.parse(fs.readFileSync(path.join(s.directory, 'session.json')));
    assert.equal(record.owner.pid, 202); assert.equal(record.attempted, true);
    const stopped = s.focus.stop(); await s.time.tick(1000);
    assert.deepEqual(await stopped, { restoration: 'restored' });
    assert.deepEqual(s.events, ['projected:202', 'native:101']);
    assert.equal(fs.existsSync(s.directory), false);
});

test('late acquisition ACK during cancellation is retained before restoring', async t => {
    const pendingAcquire = deferred(), s = scenario(t, { pendingAcquire }); await flush(); await flush();
    const stopped = s.focus.stop(); await s.time.tick(1000);
    assert.deepEqual(s.events, ['projected:202']);
    pendingAcquire.resolve(true); await flush(); await s.time.tick(1000);
    assert.equal((await stopped).restoration, 'restored');
    assert.equal(fs.existsSync(s.directory), false);
});

test('restoration failure rejects stop and retains the exclusive lock', async t => {
    const s = scenario(t, { failRestore: true }); await flush(); await flush();
    const rejected = assert.rejects(s.focus.stop(), /focus-restore-unconfirmed/);
    await s.time.tick(1000); await rejected;
    assert.equal(fs.existsSync(s.directory), true);
    assert.throws(() => s.competitor().acquire(), /focus-locked/);
});

test('orphan owner holds the lock until its delayed restoration finishes', async t => {
    const s = scenario(t, { deferOrphanContext: true }); await flush(); await flush();
    s.processes.get(101).proc.exit(null); await flush(); await flush();
    await assert.rejects(s.focus.stop(), /focus-restore-unconfirmed/);
    assert.throws(() => s.competitor().acquire(), /focus-locked/);
    assert.deepEqual(s.events, ['projected:202']);
    s.restore().resolve({ state: 1, applet: 42 }); await flush(); await s.time.tick(100);
    assert.deepEqual(s.events, ['projected:202', 'native:202']);
    assert.equal(fs.existsSync(s.directory), false);
    const next = s.competitor(); next.acquire(); next.release('supervisor');
});

test('killing an owner with an unanswered acquisition never unlocks a new generation', async t => {
    const s = scenario(t, { pendingAcquire: deferred() }); await flush(); await flush();
    const rejected = assert.rejects(s.focus.stop(), /focus-restore-unconfirmed/);
    await s.time.tick(5000); await rejected;
    assert.deepEqual(s.processes.get(202).handle.signals, ['SIGKILL']);
    assert.equal(fs.existsSync(s.directory), true);
    assert.throws(() => s.competitor().acquire(), /focus-locked/);
});

test('owner lease restores after supervisor freeze but keeps lock while supervisor lives', async t => {
    const s = scenario(t); await flush(); await flush();
    s.time.frozen.add(101);
    await s.time.tick(2500);
    assert.deepEqual(s.events, ['projected:202', 'native:202']);
    assert.equal(fs.existsSync(s.directory), true);
    assert.throws(() => s.competitor().acquire(), /focus-locked/);
    const rejected = assert.rejects(s.focus.stop(), /focus-restore-unconfirmed/);
    await s.time.tick(14000); await rejected;
});

test('original AA foreground retains MAIN and never requests NATIVE', async t => {
    const s = scenario(t); await flush(); await flush();
    s.context({ state: 1, applet: 50 });
    const stopped = s.focus.stop(); await s.time.tick(1000);
    assert.equal((await stopped).restoration, 'native-aa-retained');
    assert.deepEqual(s.events, ['projected:202']);
    assert.equal(fs.existsSync(s.directory), false);
});

test('context changed before acquisition does not send NATIVE for an unacquired session', async t => {
    const s = scenario(t, { contextApplet: 50 }); await flush(); await s.time.tick(1000);
    assert.deepEqual(s.events, []);
    assert.equal(fs.existsSync(s.directory), false);
    assert.equal((await s.focus.stop()).restoration, 'not-acquired');
});
