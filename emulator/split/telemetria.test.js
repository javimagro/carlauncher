'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { start, report } = require('../../apps/javi_carlauncher/telemetria-mgu.js');
const { consume } = require('../../native/javi-carlab/telemetry-input.js');
const { drawHome } = require('../../native/javi-carlab/drivehub-view.js');
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('the probe reads named fields only and unsubscribes when closed', async () => {
    const removed = [];
    let notify;
    const builders = {
        buildTypedProxy(service, instance) {
            if (service.endsWith('.Positioning')) {
                assert.equal(instance, 'Main_Instance');
                return {
                    init() {}, waitUntilAvailable() {},
                    rawPositionData: { getValue: () => ({
                        fixType: 'FIX_3D', utcDateTime: 'test', position: {
                            heightValid: true, height: { rawLengthMeter: -14 }, latitude: 40, longitude: -3
                        }
                    }) }
                };
            }
            if (service.endsWith('.LSCDataSink')) {
                return {
                    init() {}, waitUntilAvailable() {},
                    displayConditionHybrid: {
                        subscribe(listener) { notify = listener; return 0; },
                        unsubscribe(id) { removed.push(id); }
                    },
                    dataRangeDisplay: {
                        subscribe() { return 1; },
                        unsubscribe(id) { removed.push(id); }
                    }
                };
            }
            throw new Error('proxy unavailable');
        }
    };
    const probe = start(builders);
    await turn();
    notify({ displayChargingconditionHighvoltageStorage: 255 });
    notify({ displayChargingconditionHighvoltageStorage: 0 });
    probe.stop();
    probe.stop();
    notify({ displayChargingconditionHighvoltageStorage: 25 });
    await turn();

    const records = probe.snapshot();
    const record = (name) => records.find(({ signal }) => signal === name);
    assert.deepEqual(record('rawPositionData').fields, {
        fixType: 'FIX_3D', 'position.heightValid': true, 'position.height.rawLengthMeter': -14
    });
    assert.deepEqual(record('displayConditionHybrid').fields, { displayChargingconditionHighvoltageStorage: 0 });
    assert.equal(record('dataRangeDisplay').status, 'no-sample');
    assert.equal(record('statusCarSpeed2').phase, 'proxy');
    assert.deepEqual(removed, [0, 1]);
    assert.equal(records.length, new Set(records.map(({ signal }) => signal)).size);
});

test('a subscription resolved after closing is still removed', async () => {
    const removed = [];
    let complete;
    const builders = {
        buildTypedProxy(service) {
            if (!service.endsWith('.EnvironmentalInformation')) throw new Error('proxy unavailable');
            return {
                init() {}, waitUntilAvailable() {},
                ExteriorTemperature: {
                    subscribe: () => new Promise((resolve) => { complete = resolve; }),
                    unsubscribe: (id) => removed.push(id)
                }
            };
        }
    };
    const probe = start(builders);
    await turn();
    probe.stop();
    complete(22);
    await turn();
    assert.deepEqual(removed, [22]);
});

test('speed is refreshed while visible and a getter cannot replace a newer notification', async () => {
    const pending = new Map();
    const removed = [];
    let notify;
    let complete;
    let calls = 0;
    const builders = {
        buildTypedProxy(service) {
            if (!service.endsWith('.Vehicle2')) throw new Error('proxy unavailable');
            return {
                init() {}, waitUntilAvailable() {},
                statusCarSpeed2: {
                    getValue() {
                        calls++;
                        if (calls === 1) return { speedVehicleCentreOfGravity: 0 };
                        if (calls === 2) return { speedVehicleCentreOfGravity: 640 };
                        return new Promise((resolve) => { complete = resolve; });
                    },
                    subscribe(listener) { notify = listener; return 12; },
                    unsubscribe(id) { removed.push(id); }
                }
            };
        }
    };
    const probe = start(builders, (fn, delay) => { pending.set(fn, delay); return fn; }, (id) => pending.delete(id));
    const speed = () => probe.snapshot().find(({ signal }) => signal === 'statusCarSpeed2');
    function next() {
        const [[run, delay]] = pending;
        assert.equal(delay, 2000);
        pending.delete(run);
        run();
    }
    await turn();
    assert.equal(speed().fields.speedVehicleCentreOfGravity, 0);
    next();
    await turn();
    assert.equal(speed().fields.speedVehicleCentreOfGravity, 640);
    assert.equal(speed().freshForMs, 6000);
    next();
    assert.equal(pending.size, 0);
    notify({ speedVehicleCentreOfGravity: 1280 });
    complete({ speedVehicleCentreOfGravity: 640 });
    await turn();
    assert.equal(speed().fields.speedVehicleCentreOfGravity, 1280);
    assert.equal(pending.size, 1);
    notify({ speedVehicleCentreOfGravity: 0 });
    assert.equal(speed().fields.speedVehicleCentreOfGravity, 0);
    probe.stop();
    await turn();
    assert.deepEqual(removed, [12]);
    assert.equal(pending.size, 0);
    assert.equal(calls, 3);
});

test('a slower getter keeps updating without subscriptions and retries after a read failure', async () => {
    const pending = new Map();
    let calls = 0;
    const probe = start({
        buildTypedProxy(service) {
            if (!service.endsWith('.BcPersonal')) throw new Error('proxy unavailable');
            return {
                init() {}, waitUntilAvailable() {},
                driveSegment: { getValue() {
                    calls++;
                    if (calls === 2) throw new Error('read failed');
                    return { bcBeTripDistanceKm: calls * 10 };
                } }
            };
        }
    }, (fn, delay) => { pending.set(fn, delay); return fn; }, (id) => pending.delete(id));
    const segment = () => probe.snapshot().find(({ signal }) => signal === 'driveSegment');
    await turn();
    assert.equal(segment().fields.bcBeTripDistanceKm, 10);
    const initialTime = segment().sampledAt;
    for (let i = 0; i < 2; i++) {
        const [[run, delay]] = pending;
        assert.equal(delay, 10000);
        pending.delete(run);
        run();
        await turn();
        if (i === 0) assert.equal(segment().sampledAt, initialTime);
    }
    assert.equal(segment().fields.bcBeTripDistanceKm, 30);
    probe.stop();
    assert.equal(pending.size, 0);
});

test('preconditioning distinguishes the active flag from the selected mode and missing data', async () => {
    for (const [raw, expected] of [[1, true], [3, true], [4, false], [61, null], [63, null]]) {
        const builders = {
            buildTypedProxy(service) {
                if (!service.endsWith('.PredictiveThermalManagement')) throw new Error('proxy unavailable');
                return {
                    init() {}, waitUntilAvailable() {},
                    statusPredictiveThermalManagement: {
                        subscribe() { throw new Error('notifications unavailable'); },
                        unsubscribe() {},
                        getValue: () => ({ statusVWM: raw, statusFeedbackVWM: 2, operationModeVWM: 1 })
                    }
                };
            }
        };
        const probe = start(builders);
        await turn();
        probe.stop();
        const status = probe.snapshot().find(({ signal }) => signal === 'statusPredictiveThermalManagement');
        assert.deepEqual(status.fields, { statusVWM: raw, statusFeedbackVWM: 2, preconditioningActive: expected });
    }
});

test('the app sends samples to the renderer while visible and disconnects when hidden', async (context) => {
    const builders = {
        buildTypedProxy(service, instance) {
            if (!service.endsWith('.AndroidAutoProjectedManager')) throw new Error('proxy unavailable');
            assert.equal(instance, 'AndroidAutoProjectedManagerInst1');
            return {
                init() {}, waitUntilAvailable() {},
                isVideoStreaming: {
                    subscribe() { return 1; },
                    unsubscribe() {},
                    getValue() { return true; }
                }
            };
        }
    };
    let connected;
    let ready;
    const records = new Promise((resolve) => { ready = resolve; });
    const server = net.createServer((peer) => {
        connected = peer;
        const read = consume((rows) => ready(rows));
        peer.on('data', (data) => assert.equal(read(data), true));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const client = report(builders, { host: '127.0.0.1', port: server.address().port });
    context.after(() => {
        client.show(false);
        if (connected) connected.destroy();
        server.close();
    });
    client.show(true);
    const rows = await records;
    assert.deepEqual(rows.find(({ signal }) => signal === 'isVideoStreaming').fields, { value: true });
    const closed = new Promise((resolve) => connected.once('close', resolve));
    client.show(false);
    await closed;
});

test('telemetry frames accept partial reads and reject malformed and oversized data', () => {
    const frames = [];
    const read = consume((records) => frames.push(records));
    const input = Buffer.from('{"version":1,"records":[{"signal":"driveSegment","status":"no-sample"}]}\n');
    assert.equal(read(input.subarray(0, 30)), true);
    assert.deepEqual(frames, []);
    assert.equal(read(input.subarray(30)), true);
    assert.deepEqual(frames, [[{ signal: 'driveSegment', status: 'no-sample' }]]);
    assert.equal(read(Buffer.from('{"version":2,"records":[]}\n')), false);
    assert.equal(read(Buffer.alloc(17 * 1024, 65)), false);
});

test('the dashboard shows diagnostics and a live thermal status alongside clearly marked example data', () => {
    const labels = [];
    const canvas = new Proxy({ text: (text) => labels.push(text), textWidth: () => 100 }, {
        get: (target, key) => target[key] || (() => {})
    });
    const state = { selected: 0, article: 0 };
    drawHome(canvas, state, 0, {
        city: 'Madrid', energy: [{ label: 'Ahora', soc: 64, range: 248 }], diagnostics: true,
        telemetry: [
            { signal: 'statusPredictiveThermalManagement', status: 'sample', fields: { preconditioningActive: true, statusVWM: 1 } },
            { signal: 'isVideoStreaming', status: 'sample', fields: { value: false } },
            { signal: 'statusChargeOfBatteryHybrid', status: 'error', phase: 'getter' }
        ]
    }, () => 1, 0);
    for (const label of ['Precalentamiento activo', 'Sí  ·  1', 'Android Auto · vídeo', 'No',
        'Error de lectura', 'TRAYECTO · DEMO', 'Demostración']) assert(labels.includes(label), label);
});

test('the dashboard distinguishes zero speed, missing speed and an expired reading', () => {
    const labels = [];
    const canvas = new Proxy({ text: (text) => labels.push(text), textWidth: () => 100 }, {
        get: (target, key) => target[key] || (() => {})
    });
    const state = { selected: 0, article: 0 };
    for (const [raw, now, expected] of [[0, 2000, '0 km/h'], [1280, 2000, '20 km/h'],
        [65535, 2000, 'Sin dato válido'], [0, 7000, 'Sin actualizar']]) {
        labels.length = 0;
        drawHome(canvas, state, 0, { energy: [], diagnostics: true, telemetry: [{ signal: 'statusCarSpeed2',
            status: 'sample', fields: { speedVehicleCentreOfGravity: raw }, sampledAt: 1000, freshForMs: 6000 }] }, () => 1, now);
        assert(labels.includes(expected), expected);
    }
});
