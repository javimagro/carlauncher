'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { start, report } = require('../../apps/javi_carlauncher/telemetria-mgu.js');
const { createPowerProbe, service: tasu, instance: tasuInstance } = require('../../apps/javi_carlauncher/potencia-hv.js');
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
                            heightValid: true, coordinatesValid: true, height: { rawLengthMeter: -14 },
                            latitude: 40, longitude: -3, unverifiedField: 42
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
        fixType: 'FIX_3D', 'position.heightValid': true, 'position.height.rawLengthMeter': -14,
        'position.coordinatesValid': true, 'position.latitude': 40, 'position.longitude': -3
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
        cockpitStatus: 'Cluster renderer no responde',
        telemetry: [
            { signal: 'statusPredictiveThermalManagement', status: 'sample', fields: { preconditioningActive: true, statusVWM: 1 } },
            { signal: 'isVideoStreaming', status: 'sample', fields: { value: false } },
            { signal: 'statusChargeOfBatteryHybrid', status: 'error', phase: 'getter' }
        ]
    }, () => 1, 0);
    for (const label of ['Sí  ·  1', 'Android Auto · vídeo', 'No', 'Cluster renderer no responde',
        'Error de lectura', 'TRAYECTO', 'Ruta de ejemplo']) assert(labels.includes(label), label);
    for (const label of ['25,3 kWh/100 km', '50,9 km', '917 m', 'Activo', 'Periodo']) assert(!labels.includes(label), label);
    assert(!labels.includes('64%'));
    assert(!labels.includes('248 km'));
});

test('the dashboard converts validated readings and never substitutes demo values for missing live energy', () => {
    const labels = [];
    const canvas = new Proxy({ text: (text) => labels.push(text), textWidth: () => 100 }, {
        get: (target, key) => target[key] || (() => {})
    });
    const state = { selected: 0, article: 0 };
    const samples = {
        statusChargeOfBatteryHybrid: { displayChargingConditionHighVoltageStorage: 182 },
        displayRangeElectricVehicle: { displayRangeElectricVehicle: 431 },
        ExteriorTemperature: { temperatureExterior: 112 },
        statusBatteryTemperature: { actualValueTemperatureHighVoltageStorage: 69 },
        statusConsumptionAverageElectricVehicle: { consumptionAverageElectricVehicleBC1: 170,
            consumptionAverageElectricVehicleBC2: 4095, unitOfMeasurementConsumptionElectricVehicleBC: 1 }
    };
    const telemetry = Object.entries(samples).map(([signal, fields]) => ({ signal, fields, status: 'sample', sampledAt: 0, freshForMs: 30000 }));
    const data = { energy: [{ label: 'Ahora', soc: 64, range: 248 }, { label: 'En destino', soc: 24, range: 93 }],
        diagnostics: true, telemetry };
    drawHome(canvas, state, 0, data, () => 1, 1000);
    for (const label of ['91%', '91 %', '431 km', '16 °C', '19 °C', '17,0  ·  – kWh/100 km', '24%', 'Ruta de ejemplo']) {
        assert(labels.includes(label), label);
    }
    assert.equal(labels.filter((label) => label === '431 km').length, 2);
    labels.length = 0;
    drawHome(canvas, state, 0, data, () => 1, 30000);
    for (const label of ['91%', '431 km', '16 °C', '19 °C', '64%', '248 km']) assert(!labels.includes(label), label);
    assert(labels.includes('Sin actualizar'));

    samples.statusBatteryTemperature.actualValueTemperatureHighVoltageStorage = 255;
    samples.statusChargeOfBatteryHybrid.displayChargingConditionHighVoltageStorage = 255;
    samples.displayRangeElectricVehicle.displayRangeElectricVehicle = 4095;
    labels.length = 0;
    drawHome(canvas, state, 0, data, () => 1, 1000);
    assert.equal(labels.filter((label) => label === 'Sin dato válido').length, 3);
    assert(!labels.includes('205 °C'));
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

test('the trip probe maps periods by reset option and presents scaled distances and averages', async (t) => {
    const builders = {
        buildTypedProxy(service) {
            if (!service.endsWith('.ResetLogic3')) throw new Error('proxy unavailable');
            return {
                init() {}, waitUntilAvailable() {},
                bcDataAll: {
                    getValue: () => ({
                        bcUnits: { tachoDigital: 'KILOMETERS', averageConsumptionElectric: 1 },
                        bcData3: [
                            { resetOption: 5, counterDistance: 450340, consumptionElectricAverageDigit: 65718 },
                            { resetOption: 'STARTOFDRIVING', counterDistance: 345, consumptionElectricAverageDigit: 65753,
                                speedAverage: 425, dateTimeTrip: { day: 0, hour: 1, minute: 7, second: 0 } },
                            { resetOption: 'INDIVIDUAL', counterDistance: 0xfffffffd },
                            { resetOption: 3, counterDistance: 523, consumptionElectricAverageDigit: 65763 },
                            { resetOption: 'REFUEL', counterDistance: 900, consumptionElectricAverageDigit: 65742 }
                        ]
                    })
                }
            };
        }
    };
    const probe = start(builders);
    t.after(() => probe.stop());
    await turn();
    const labels = [];
    const canvas = new Proxy({ text: (text) => labels.push(text), textWidth: () => 100 }, {
        get: (target, key) => target[key] || (() => {})
    });
    drawHome(canvas, { selected: 0, article: 0 }, 0,
        { energy: [], diagnostics: true, telemetry: probe.snapshot() }, () => 1, Date.now());
    for (const label of ['34,5 km  ·  21,8 kWh/100 km', '52,3 km  ·  22,8 kWh/100 km',
        '45034 km  ·  18,3 kWh/100 km', '34,5 km', '21,8 kWh/100 km', '18,3 kWh/100 km',
        '43 km/h', '1 h 07 m', '7,5 kWh aprox.', '–  ·  –']) {
        assert(labels.includes(label), label);
    }
    assert(!labels.includes('90 km  ·  20,7 kWh/100 km'));
    labels.length = 0;
    drawHome(canvas, { selected: 0, article: 0 }, 0,
        { energy: [], telemetry: probe.snapshot() }, () => 1, Date.now());
    for (const label of ['Consumo medio', 'Consumo medio total', 'Distancia recorrida', 'Velocidad media',
        'Energía consumida', 'Duración', 'Altura', 'Exterior', 'Batería HV']) assert(labels.includes(label), label);
    for (const label of ['Inicio de viaje', 'Última carga', 'Individual', 'Desde fábrica',
        'Velocidad', 'Batería', 'Autonomía', 'Carga rápida', 'Precalentamiento']) assert(!labels.includes(label), label);
});

test('the charging limit follows the fresh BMS status independently of battery temperature', () => {
    const labels = [];
    const canvas = new Proxy({ text: (text) => labels.push(text), textWidth: () => 100 }, {
        get: (target, key) => target[key] || (() => {})
    });
    const thermal = { signal: 'statusHighVoltageBattery', status: 'sample', sampledAt: 1000, freshForMs: 15000,
        fields: { thermalStatusHighVoltageBatteryForFastCharging: 2 } };
    const data = { energy: [], diagnostics: true, telemetry: [thermal, {
        signal: 'statusBatteryTemperature', status: 'sample', sampledAt: 1000, freshForMs: 30000,
        fields: { actualValueTemperatureHighVoltageStorage: 83 }
    }] };
    const render = (now) => {
        labels.length = 0;
        drawHome(canvas, { selected: 0, article: 0 }, 0, data, () => 1, now);
    };
    render(1001);
    assert(labels.includes('33 °C'));
    assert(labels.includes('Limitación condicional por frío'));
    thermal.fields.thermalStatusHighVoltageBatteryForFastCharging = 'NO_THERMAL_LIMITATIONS';
    render(2000);
    assert(labels.includes('Sin limitaciones'));
    render(16000);
    assert(labels.includes('33 °C'));
    assert(labels.includes('Sin actualizar'));
    assert(!labels.includes('Sin limitaciones'));
});

function tasuReply(did, payload, ecu = 7) {
    return { errorCode: 'NO_ERROR', udsResponse: Buffer.from([
        0, 0, 0, 0, 0, 0, ecu, 0, 0, 0x62, did >> 8, did & 0xff, ...payload
    ]) };
}

test('the battery power probe reads only the SME voltage and signed current and displays their product', async (t) => {
    const requests = [];
    const removed = [];
    let notify;
    let currentRaw = [0, 0, 0xec, 0x78];
    const proxy = {
        sendTasuResponse: {
            subscribe(listener) { notify = listener; return 0; },
            unsubscribe(id) { removed.push(id); }
        },
        sendTasuRequest(request) {
            requests.push(request);
            const did = request.udsData.readUInt16BE();
            const payload = did === 0xe54d ? [0x9c, 0x40] : currentRaw;
            notify(tasuReply(did, [0, 0, 0, 0], 0x12));
            notify(tasuReply(0xe555, [0, 0, 0, 0]));
            notify(tasuReply(did, payload));
            return did === 0xe54d ? undefined : { TasuErrorEnum: 'NO_ERROR' };
        }
    };
    const probe = createPowerProbe({
        buildAndInitTypedProxy(service, instance) {
            assert.equal(service, tasu);
            assert.equal(instance, tasuInstance);
            return proxy;
        }
    }, { periodMs: 60 });
    t.after(() => probe.show(false));
    probe.show(true);
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    for (let i = 0; i < 40 && probe.snapshot().status !== 'sample'; i++) await delay(10);
    assert.deepEqual(probe.snapshot().fields, { kw: 20, volts: 400, amps: 50 });
    currentRaw = [0, 0, 0x13, 0x88];
    for (let i = 0; i < 40 && probe.snapshot().fields.kw !== -20; i++) await delay(10);
    const record = probe.snapshot();
    assert.deepEqual(record.fields, { kw: -20, volts: 400, amps: -50 });
    assert.deepEqual(requests.map((request) => request.udsData.toString('hex')), ['e54d', 'e561', 'e54d', 'e561']);
    for (const request of requests) {
        assert.equal(request.targetAddress, 7);
        assert.equal(request.serviceID, 0x22);
        assert.equal(request.udsDataLength, 2);
    }
    const labels = [];
    const canvas = new Proxy({ text: (text) => labels.push(text), textWidth: () => 100 }, {
        get: (target, key) => target[key] || (() => {})
    });
    drawHome(canvas, { selected: 0, article: 0 }, 0,
        { energy: [], diagnostics: true, telemetry: [record] }, () => 1, record.sampledAt);
    assert(labels.includes('-20 kW  ·  400 V  ·  -50 A'));
    probe.show(false);
    await turn();
    assert.deepEqual(removed, [0]);
    assert.equal(probe.snapshot().status, 'no-sample');
});

test('hiding and reopening during a diagnostic request waits for the previous TASU proxy to close', async (t) => {
    let complete;
    let sent = 0;
    const lifecycle = [];
    const probe = createPowerProbe({
        buildAndInitTypedProxy() {
            lifecycle.push('open');
            return {
                sendTasuResponse: { subscribe() { return 1; }, unsubscribe() { lifecycle.push('unsubscribe'); } },
                sendTasuRequest() {
                    sent++;
                    if (sent === 1) return new Promise((resolve) => { complete = resolve; });
                    return { TasuErrorEnum: 'APP_REQUEST_TEMPORARILY_NOT_ACCEPTED' };
                },
                dispose() { lifecycle.push('dispose'); }
            };
        }
    });
    t.after(() => probe.show(false));
    probe.show(true);
    await turn();
    probe.show(false);
    probe.show(true);
    await turn();
    assert.deepEqual(lifecycle, ['open']);
    complete({ TasuErrorEnum: 'NO_ERROR' });
    await turn();
    assert.deepEqual(lifecycle, ['open', 'unsubscribe', 'dispose', 'open']);
    assert.equal(sent, 2);
    assert.equal(probe.snapshot().status, 'error');
    assert.deepEqual(probe.snapshot().fields, { stage: 'voltage', failure: 'tasu', code: 7 });
});

test('a negative SME reply identifies the current request and shows the UDS code', async (t) => {
    let notify;
    const probe = createPowerProbe({
        buildAndInitTypedProxy() {
            return {
                sendTasuResponse: { subscribe(listener) { notify = listener; }, unsubscribe() {} },
                sendTasuRequest(request) {
                    if (request.udsData.readUInt16BE() === 0xe54d) {
                        notify(tasuReply(0xe54d, [0x9c, 0x40]));
                    } else {
                        const reply = tasuReply(0xe561, []);
                        Buffer.from([0x7f, 0x22, 0x31]).copy(reply.udsResponse, 9);
                        notify(reply);
                    }
                    return { TasuErrorEnum: 'NO_ERROR' };
                }
            };
        }
    });
    t.after(() => probe.show(false));
    probe.show(true);
    for (let i = 0; i < 25 && probe.snapshot().status !== 'error'; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const record = probe.snapshot();
    assert.deepEqual(record.fields, { stage: 'current', failure: 'uds', code: 0x31 });
    const labels = [];
    const canvas = new Proxy({ text: (text) => labels.push(text), textWidth: () => 100 }, {
        get: (target, key) => target[key] || (() => {})
    });
    drawHome(canvas, { selected: 0, article: 0 }, 0,
        { energy: [], diagnostics: true, telemetry: [record] }, () => 1, Date.now());
    assert(labels.includes('Corriente · UDS 0x31'));
});
