'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInput } = require('../../native/javi-carlab/aa-input-process');
const { run, releaseOnce } = require('../../native/javi-carlab/aa-input-worker');

function clock() {
    let time = 0, id = 0;
    const timers = new Map();
    return { now: () => time, timers,
        setTimeout(fn, delay) { const key = ++id; timers.set(key, { fn, at: time + delay }); return key; },
        clearTimeout(key) { timers.delete(key); },
        advance(ms) {
            const end = time + ms;
            for (;;) {
                const item = Array.from(timers.entries()).filter(p => p[1].at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!item) break;
                time = item[1].at; timers.delete(item[0]); item[1].fn();
            }
            time = end;
        },
        jump(ms) { time += ms; }
    };
}
const point = { x: 960, y: 540 };
const physical = { x: 1500, y: 420 };
const settle = async () => { for (let n = 0; n < 6; n++) await Promise.resolve(); };

function parentFixture() {
    const time = clock(), children = [], errors = [], timings = [];
    let permitted = true;
    const input = createInput(Object.assign({}, time, { allowed: () => permitted, onError: code => errors.push(code),
        onTiming: value => timings.push(value),
        fork(file, args, options) {
            assert.match(file, /aa-input-worker\.js$/);
            assert.equal(options.detached, true); assert.equal(options.windowsHide, true);
            const child = new EventEmitter(); child.args = args; child.messages = []; child.signals = [];
            child.connected = true; child.exitCode = null;
            child.send = (message, callback) => { child.messages.push(message); if (callback) callback(); return true; };
            child.kill = signal => { child.signals.push(signal); };
            child.exit = code => { child.connected = false; child.exitCode = code; child.emit('exit', code); };
            child.reply = message => child.emit('message', message);
            child.ackLease = () => {
                const leases = child.messages.filter(m => m.op === 'lease');
                child.reply({ op: 'ready', seq: leases[leases.length - 1].seq, ready: true });
            };
            children.push(child); return child;
        } }));
    return { input, time, children, errors, timings, allow(value) { permitted = value; },
        arm() { input.enable(true); input.setVisible(true); input.setFocus(true); children[0].ackLease(); } };
}

function workerFixture(recovery) {
    const time = clock(), proc = new EventEmitter(), messages = [], packets = [], exits = [];
    let closes = 0;
    proc.connected = true;
    proc.send = (message, callback) => { messages.push(message); if (callback) callback(); };
    proc.exit = code => { exits.push(code); };
    const options = Object.assign({}, time, { process: proc, createSocket: () => ({
        on() {}, close() { closes++; }, send(bytes, port, host, callback) {
            assert.equal(port, 30567); assert.equal(host, '127.0.0.1'); packets.push(bytes); callback();
        } }) });
    if (recovery) releaseOnce(options); else run(options);
    return { time, proc, messages, packets, exits, closes: () => closes,
        lease(seq) { proc.emit('message', { op: 'lease', seq, focus: true }); },
        touch() { proc.emit('message', { op: 'touch', id: 1, phase: 'down', point }); } };
}

test('AA process starts only for an enabled visible owner and requires a fresh worker ACK', async () => {
    const f = parentFixture();
    f.input.setVisible(true); assert.equal(f.children.length, 0);
    f.allow(false); f.input.enable(true); assert.equal(f.children.length, 0);
    f.allow(true); f.time.advance(250); assert.equal(f.children.length, 1);
    assert.equal(f.input.ready(), false);
    const child = f.children[0]; child.ackLease(); assert.equal(f.input.ready(), true);
    f.time.advance(250); child.ackLease();
    assert.equal(child.messages.filter(m => m.op === 'lease').length, 2);
    f.allow(false); assert.equal(f.input.ready(), false);
    f.time.advance(250); assert.equal(child.messages[child.messages.length - 1].op, 'stop');
    const closed = f.input.close(); child.exit(0); await closed;
    assert.equal(f.time.timers.size, 0);
});

test('AA cold startup allows a first ACK after 700 ms without admitting touch or extending the active lease', async () => {
    const f = parentFixture(); f.input.enable(true); f.input.setVisible(true); f.input.setFocus(true);
    const child = f.children[0]; f.time.advance(1750);
    assert.equal(f.input.ready(), false); assert.equal(f.input.touch('down', point), false);
    assert.equal(child.messages.some(m => m.op === 'touch' || m.op === 'stop'), false);
    assert.deepEqual(f.errors, []);
    child.ackLease(); assert.equal(f.input.ready(), true);
    assert.deepEqual(f.timings, [{ event: 'first-ack', elapsedMs: 1750, ready: true }]);
    f.time.advance(699); assert.equal(f.input.ready(), true);
    f.time.advance(1); assert.equal(f.input.ready(), false);
    f.time.advance(50); assert.deepEqual(f.errors, ['input-worker-unresponsive']);
    assert.equal(f.timings.length, 1);
    const closed = f.input.close(); child.exit(0); await closed;
    assert.equal(f.time.timers.size, 0);
});

test('AA cold startup ends at 2000 ms with a distinct error and rejects a late first ACK', async () => {
    for (const suspended of [false, true]) {
        const f = parentFixture(); f.input.enable(true); f.input.setVisible(true); f.input.setFocus(true);
        const child = f.children[0];
        if (suspended) f.time.jump(2001); else f.time.advance(2000);
        child.ackLease();
        assert.equal(f.input.ready(), false); assert.equal(f.input.touch('down', point), false);
        assert.deepEqual(f.errors, ['input-worker-start-timeout']); assert.deepEqual(f.timings, []);
        assert.equal(child.messages.some(m => m.op === 'touch'), false);
        const closed = f.input.close(); child.exit(0); await closed;
        assert.equal(f.time.timers.size, 0);
    }
});

test('AA process bounds touch IPC, coalesces motion and withdraws on every-send guard failure', async () => {
    const f = parentFixture(); f.arm(); const child = f.children[0];
    assert.equal(f.input.touch('down', point), true);
    for (let n = 0; n < 1000; n++) f.input.touch('move', { x: n, y: 500 });
    let touches = child.messages.filter(m => m.op === 'touch'); assert.equal(touches.length, 1);
    child.reply({ op: 'sent', event: 1, point: physical });
    child.reply({ op: 'ack', id: touches[0].id, accepted: true });
    touches = child.messages.filter(m => m.op === 'touch'); assert.equal(touches.length, 2);
    assert.equal(touches[1].point.x, 999);
    f.allow(false);
    for (let n = 0; n < 1000; n++) f.input.touch('move', point);
    assert.equal(child.messages.filter(m => m.op === 'cancel').length, 1);
    child.reply({ op: 'sent', event: 3, point: physical });
    const closed = f.input.close(); child.exit(0); await closed;
    assert.equal(f.children.length, 1); assert.equal(f.time.timers.size, 0);
});

test('AA process recovers only UP after its worker dies, using confirmed coordinates', async () => {
    const f = parentFixture(); f.arm(); const child = f.children[0];
    f.input.touch('down', point); child.reply({ op: 'sent', event: 1, point: physical });
    child.exit(null);
    assert.equal(f.input.ready(), false); assert.equal(f.children.length, 2);
    const recovery = f.children[1]; assert.deepEqual(recovery.args, ['--release']);
    assert.deepEqual(recovery.messages, [{ op: 'release', point: physical }]);
    const closed = f.input.close(); recovery.reply({ op: 'released' }); recovery.exit(0); await closed;
    assert.equal(f.children.length, 2); assert.equal(f.time.timers.size, 0);
});

test('AA process covers the UDP/ACK gap and never recovers before worker exit is observed', async () => {
    const f = parentFixture(); f.arm(); const child = f.children[0];
    f.input.touch('down', point);
    f.time.advance(750);
    assert.equal(f.input.ready(), false); assert.equal(f.children.length, 1);
    f.time.advance(350); assert.deepEqual(child.signals, ['SIGKILL']);
    assert.equal(f.children.length, 1);
    child.exit(null); assert.equal(f.children.length, 2);
    assert.deepEqual(f.children[1].messages[0].point, physical);
    const closed = f.input.close(); f.children[1].reply({ op: 'released' }); f.children[1].exit(0); await closed;
    assert.equal(f.time.timers.size, 0);
});

test('AA worker releases on lease expiry and rejects renewal after a suspended deadline', async () => {
    for (const suspend of [false, true]) {
        const f = workerFixture(); f.lease(1); f.touch();
        assert.deepEqual(f.packets.map(p => p[63] >> 4), [1]);
        if (suspend) { f.time.jump(701); f.lease(2); }
        else f.time.advance(700);
        await settle();
        assert.deepEqual(f.packets.map(p => p[63] >> 4), [1, 3]);
        assert.equal(f.closes(), 1); assert.deepEqual(f.exits, [1]);
        assert.equal(f.time.timers.size, 0);
    }
});

test('AA worker survives loss of UI ownership long enough to close its own finger', async () => {
    const f = workerFixture(); f.lease(1); f.touch();
    f.time.advance(250); f.lease(2); f.time.advance(250); f.lease(3);
    assert.equal(f.packets.length, 1);
    f.proc.connected = false; f.proc.emit('disconnect'); await settle();
    assert.deepEqual(f.packets.map(p => p[63] >> 4), [1, 3]);
    assert.deepEqual(f.exits, [1]); assert.equal(f.closes(), 1); assert.equal(f.time.timers.size, 0);
});

test('AA recovery worker can emit exactly one release and never a new down', () => {
    const f = workerFixture(true);
    f.proc.emit('message', { op: 'touch', phase: 'down', point }); assert.equal(f.packets.length, 0);
    f.proc.emit('message', { op: 'release', point: physical });
    f.proc.emit('message', { op: 'release', point: physical });
    assert.deepEqual(f.packets.map(p => p[63] >> 4), [3]);
    assert.equal(f.closes(), 1); assert.deepEqual(f.exits, [0]); assert.equal(f.time.timers.size, 0);
});
