'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { contracts, inspect, nativeBuilders } = require('../../tools/assistant-runtime/inspect-microphone');

test('microphone diagnostic only reads declared getters and shuts down each SDK proxy', async () => {
    const calls = [], closed = [];
    const builders = { buildAndInitTypedProxy: async (name, instance, options) => {
        const contract = contracts.find((item) => item.name === name);
        assert.equal(instance, contract.instance); assert.equal(options.timeoutMs, 2000);
        const proxy = { shutdown: async () => closed.push(contract.key) };
        contract.fields.forEach((field) => { proxy[field] = { getValue: async (timeout) => {
            assert.equal(timeout, 1500); calls.push([contract.key, field]);
            if (field === 'currentApp') return 'PRIVATE_APP_NAME';
            if (field === 'intentsForApplications') return [{ intentgroupIdentifier: { number: 123, name: 'Rule.Name' },
                priority: 1, utterance: 'PRIVATE_SPEECH', slots: ['PRIVATE_SLOT'] }];
            return field === 'availableUsecases' ? [0, 2] : 0;
        } }; });
        return new Proxy(proxy, { get(target, key) { assert(key === 'then' || key in target, 'undeclared SDK operation: ' + String(key)); return target[key]; } });
    } };
    const report = await inspect(builders);
    assert.equal(report.recording, false); assert.equal(report.recognitionStarted, false);
    assert.deepEqual(closed, ['recognizer2', 'dialog', 'projection']);
    assert.equal(calls.length, 9);
    assert.equal(report.services.dialog.fields.currentApp.active, true);
    assert.equal(JSON.stringify(report).includes('PRIVATE'), false);
    assert.equal(report.services.recognizer2.fields.intentsForApplications.value[0].intentgroupIdentifier.number, 123);
});

test('native microphone reader strips writes, events and undeclared fields before opening a proxy', async () => {
    const contract = contracts.find((item) => item.key === 'projection');
    const config = { serviceId: contract.service, version: { major: contract.major, minor: contract.minor },
        instances: { [contract.instance]: 128 }, fields: {}, methods: { start: {} }, events: { speech: {} } };
    contract.fields.forEach((field, index) => { config.fields[field] = {
        schema: { t: 'Bool' }, getter: { id: contract.getters[index] }, setter: { id: 5 }, notifier: { id: 32769 }
    }; });
    config.fields.privateAudio = { getter: { id: 99 } };
    let closed = 0;
    const calls = [];
    const builders = nativeBuilders({ buildProxy: async (read, instance) => {
        assert.equal(instance, contract.instance);
        assert.deepEqual(read.methods, {}); assert.deepEqual(read.events, {});
        assert.deepEqual(Object.keys(read.fields), contract.fields);
        contract.fields.forEach((field) => assert.deepEqual(Object.keys(read.fields[field]), ['schema', 'getter']));
        return { init: async () => {}, waitUntilAvailable: async () => {},
            getValue: async (field, timeout) => { calls.push([field, timeout]); return false; },
            shutdown: async () => { closed++; } };
    } }, { [contract.name]: config });
    const proxy = await builders.buildAndInitTypedProxy(contract.name, contract.instance, { timeoutMs: 20 });
    assert.equal(await proxy.voiceAssistanceActive.getValue(1500), false);
    await proxy.shutdown();
    assert.equal(closed, 1); assert.deepEqual(calls, [['voiceAssistanceActive', 1500]]);
    config.fields.voiceAssistanceActive.getter.id = 5;
    await assert.rejects(builders.buildAndInitTypedProxy(contract.name, contract.instance, { timeoutMs: 20 }), /getter/);
});

test('native microphone reader closes a proxy when availability times out', async () => {
    const contract = contracts.find((item) => item.key === 'dialog');
    let closed = 0;
    const config = { serviceId: contract.service, version: { major: 1, minor: 0 }, instances: { [contract.instance]: 128 },
        fields: { currentApp: { schema: { t: 'Utf8D' }, getter: { id: 158 } } } };
    const builders = nativeBuilders({ buildProxy: async () => ({ init: async () => {}, waitUntilAvailable: () => new Promise(() => {}),
        shutdown: async () => { closed++; } }) }, { [contract.name]: config });
    await assert.rejects(builders.buildAndInitTypedProxy(contract.name, contract.instance, { timeoutMs: 10 }), /unavailable/);
    assert.equal(closed, 1);
});

test('microphone diagnostic falls back to Recognizer and bounds rule metadata', async () => {
    const report = await inspect({ buildAndInitTypedProxy: async (name) => {
        const contract = contracts.find((item) => item.name === name);
        if (contract.key === 'recognizer2') throw new Error('PRIVATE_ERROR');
        const proxy = { shutdown: async () => {} };
        contract.fields.forEach((field) => { proxy[field] = { getValue: async () => {
            if (field === 'intentsForApplications') return Array.from({ length: 100 }, () => ({ name: 'private spoken phrase', number: 1 }));
            throw new Error('PRIVATE_ERROR');
        } }; });
        return proxy;
    } });
    assert.equal(report.services.recognizer2.available, false);
    assert.equal(report.services.recognizer.fields.intentsForApplications.value.length, 64);
    assert.equal(report.services.recognizer.fields.intentsForApplications.limited, true);
    assert(!JSON.stringify(report).includes('PRIVATE'));
    assert(!JSON.stringify(report).includes('private spoken phrase'));
});
