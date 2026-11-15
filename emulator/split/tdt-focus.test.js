'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createSession, clientId } = require('../../native/javi-carlab/tdt-focus-session');
const { createFocus } = require('../../native/javi-carlab/tdt-audio-focus');
const playAudio = require('../../native/javi-carlab/tdt-audio');
const id = '0123456789abcdef0123456789abcdef';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture() {
    const calls = [];
    const f = { token: '', clientId: '', clientName: '', status: 3 };
    const state = { focus: f, connection: 0, player: 2 };
    const proxy = {
        init: async () => {}, waitUntilAvailable: async () => {}, shutdown: async () => {},
        getValue: async (name) => state[name],
        callMethod: async (name, args) => {
            calls.push({ name, args });
            if (name === 'acquire') {
                state.focus = { token: 'private', clientId: args.clientId, clientName: args.clientName, status: 0 };
                state.connection = 3;
                return { result: 0, token: 'private' };
            }
            state.focus = f; state.connection = 0;
            return { result: 0 };
        }
    };
    const session = createSession({ buildProxy: async (config, instance) => {
        assert.equal(instance, 'DynamicMediaPlayerMedia');
        assert.equal(config.instances[instance], 1);
        assert.equal(config.serviceId, 0xb0c0);
        assert.deepEqual(Object.keys(config.methods), ['acquire', 'release']);
        return proxy;
    } }, { wait: async () => {} });
    return { state, proxy, calls, session };
}
test('BMW focus owns only its token; no playlist, volume or connection writes', async () => {
    const { session, calls } = fixture();
    await session.connect(); await session.acquire(id);
    assert.equal((await session.state(id)).ready, true);
    assert.equal(calls[0].args.timeOutHeartBeatTimer, 0);
    assert.equal(calls[0].args.clientId, clientId(id));
    assert.equal(await session.release(id), true);
    assert.deepEqual(calls.map((c) => c.name), ['acquire', 'release']);
});
test('BMW focus does not take over a busy source or release a new owner', async () => {
    const { session, state, calls } = fixture();
    await session.connect();
    state.focus = { token: 'other', clientId: 'other', clientName: 'other', status: 0 }; state.connection = 3;
    await assert.rejects(session.acquire(id), /busy/);
    assert.equal(await session.release(id), true);
    assert.equal(calls.length, 0);
});
test('BMW reboot idle selection is available only with no owner and STOP', async () => {
    const { session, state, calls } = fixture(); await session.connect();
    state.connection = 3; state.focus.status = 0; state.player = 1;
    await assert.rejects(session.acquire(id), /busy/);
    assert.equal(calls.length, 0);
    state.player = 2;
    await session.acquire(id); assert.equal((await session.state(id)).ready, true);
    assert.equal(await session.release(id), true);
});
test('BMW focus releases a late successful acquisition after cancellation', async () => {
    const { session, proxy, calls } = fixture();
    const call = proxy.callMethod; let active = true;
    proxy.callMethod = async (name, args) => { const r = await call(name, args); if (name === 'acquire') active = false; return r; };
    await session.connect();
    await assert.rejects(session.acquire(id, () => active), /cancelled/);
    assert.deepEqual(calls.map((c) => c.name), ['acquire', 'release']);
});
test('BMW focus rejects incomplete state and does not reacquire stale lost focus', async () => {
    const { session, state, calls } = fixture(); await session.connect();
    state.focus = { status: 0 };
    await assert.rejects(session.acquire(id), /read/);
    state.focus = { token: 'old', clientId: clientId(id), clientName: 'BMWLauncher', status: 1 };
    assert.equal(await session.release(id), true);
    assert.equal(calls.length, 0);
});
test('audio focus supervisor keeps a lease and receives stop on cancellation', async () => {
    const peer = new EventEmitter(); peer.connected = true; const commands = [];
    peer.send = (m) => commands.push(m.op);
    const focus = createFocus(() => assert.fail('unexpected loss'), { fork: () => peer });
    const ready = focus.start(); peer.emit('message', { state: 'ready' }); await ready;
    focus.close();
    assert.deepEqual(commands, ['keepalive', 'stop']);
    peer.emit('message', { state: 'ready' }); // late reply cannot reopen it
    await assert.rejects(focus.start(), /cancelled/);
});
test('PCM drains while waiting for focus and cannot open after cancellation', async () => {
    const pcm = new EventEmitter(); let resolve, focusClosed = 0, spawned = 0, bytes = 0;
    const output = playAudio(pcm, () => {}, { push: (b) => { bytes += b.length; } }, {
        bmwFocus: true, createFocus: () => ({ start: () => new Promise((r) => { resolve = r; }), close: () => { focusClosed++; } })
    }, () => { spawned++; }, { warn() {} });
    pcm.emit('data', Buffer.alloc(1024)); pcm.emit('data', Buffer.alloc(1024));
    assert.equal(bytes, 2048); assert.equal(spawned, 0);
    output.close(); resolve(); await flush();
    assert.equal(spawned, 0); assert.ok(focusClosed > 0);
});
test('focus loss closes PCM without stopping the PCM producer or retrying', async () => {
    const pcm = new EventEmitter(), peer = new EventEmitter(); let lost, killed = 0, spawned = 0, closed = 0;
    peer.stdin = new EventEmitter(); peer.stdin.write = () => true;
    peer.stderr = new EventEmitter(); peer.kill = () => { killed++; }; peer.exitCode = 0;
    const states = [];
    const output = playAudio(pcm, (s) => states.push(s), null, { bmwFocus: true,
        createFocus: (cb) => { lost = cb; return { start: async () => {}, close: () => { closed++; } }; }
    }, () => { spawned++; return peer; }, { warn() {} });
    pcm.emit('data', Buffer.alloc(16)); await flush();
    assert.equal(spawned, 1); lost('lost'); pcm.emit('data', Buffer.alloc(16)); await flush();
    assert.equal(spawned, 1); assert.equal(killed, 1); assert.ok(closed > 0);
    assert.ok(states.includes('audio-focus-lost')); assert.equal(output.stats().receivedBytes, 32);
    output.close();
});
