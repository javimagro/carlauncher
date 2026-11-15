'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../../native/javi-carlab/aa-control');

function fixture(options) {
    const calls = [];
    let config, streaming = 0, shutdowns = 0;
    const proxy = {
        init: async () => {}, waitUntilAvailable: async () => {},
        shutdown: async () => { shutdowns++; },
        getValue: async (name) => { assert.equal(name, 'streaming'); return streaming; },
        callMethod: async (name, args) => { calls.push({ name, args }); return { result: 0 }; }
    };
    const session = createSession({ buildProxy: async (contract, instance) => {
        config = contract;
        assert.equal(instance, 'AndroidAutoProjectedManagerInst1');
        return proxy;
    } }, options);
    return { session, calls, proxy, config: () => config, shutdowns: () => shutdowns,
        streaming: (value) => { streaming = value; } };
}

test('AA transport selects only MAIN and serializes the observed focus contract', async () => {
    const f = fixture();
    await f.session.connect();
    const c = f.config();
    assert.equal(c.serviceId, 0xfb73);
    assert.deepEqual(c.instances, { AndroidAutoProjectedManagerInst1: 128 });
    assert.deepEqual(c.version, { major: 1, minor: 0 });
    assert.deepEqual(Object.keys(c.methods), ['videoFocusNotification']);
    assert.equal(c.fields.streaming.getter.id, 1);
    assert.equal(c.methods.videoFocusNotification.id, 10);
    const wire = (args) => {
        const bytes = Buffer.alloc(5);
        const schema = c.methods.videoFocusNotification.schema.e;
        assert.equal(schema[0].t, 'UInt32'); assert.equal(schema[0].bo, true);
        assert.equal(schema[1].t, 'UInt8');
        bytes.writeUInt32BE(args[schema[0].n]); bytes[4] = args[schema[1].n];
        return bytes.toString('hex');
    };
    assert.deepEqual(await f.session.state(), { streaming: false });
    f.streaming(1);
    assert.deepEqual(await f.session.state(), { streaming: true });
    await f.session.focusProjected(); await f.session.focusNative();
    assert.deepEqual(f.calls.map((call) => wire(call.args)), ['0000000001', '0000000101']);
    await f.session.close(); await f.session.close();
    assert.equal(f.shutdowns(), 1);
    assert.equal(f.calls.length, 2);
});

test('AA refuses incomplete state and nonzero focus replies', async () => {
    const f = fixture();
    await assert.rejects(f.session.state(), /not-connected/);
    await f.session.connect();
    f.streaming(2); await assert.rejects(f.session.state(), /read/);
    f.streaming(undefined); await assert.rejects(f.session.state(), /read/);
    f.proxy.callMethod = async () => ({ result: 1 });
    await assert.rejects(f.session.focusProjected(), (error) => error.message === 'focus' && error.result === 1);
    f.proxy.callMethod = async () => ({});
    await assert.rejects(f.session.focusNative(), /focus/);
    await f.session.close();
    await assert.rejects(f.session.focusProjected(), /cancelled/);
});

test('AA closes a cancelled pending connection and never sends a focus write', async () => {
    const f = fixture();
    let init;
    f.proxy.init = () => new Promise((resolve) => { init = resolve; });
    const connecting = f.session.connect();
    await new Promise((resolve) => setImmediate(resolve));
    const closed = f.session.close();
    assert.equal(f.shutdowns(), 0);
    init();
    await assert.rejects(connecting, /cancelled/); await closed;
    assert.equal(f.shutdowns(), 1); assert.equal(f.calls.length, 0);
    await assert.rejects(f.session.connect(), /cancelled/);
});

test('AA availability timeout cleans up its proxy', async () => {
    const f = fixture({ timeoutMs: 5 });
    f.proxy.waitUntilAvailable = () => new Promise(() => {});
    await assert.rejects(f.session.connect(), /unavailable/);
    assert.equal(f.shutdowns(), 1);
    await f.session.close();
    assert.equal(f.shutdowns(), 1);
});

test('AA preserves successful late acquisition so its supervisor can restore it', async () => {
    const f = fixture(); await f.session.connect();
    let reply;
    f.proxy.callMethod = () => new Promise((resolve) => { reply = resolve; });
    const acquiring = f.session.focusProjected();
    await f.session.close(); reply({ result: 0 });
    assert.equal(await acquiring, true);
});
