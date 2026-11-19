'use strict';

const net = require('net');
const { createPowerProbe } = require('./potencia-hv.js');
const { createPreconditioning, consumeCommands } = require('./preconditioning-bmw.js');

// Candidatos del catálogo MGU21. Esta sonda conserva las lecturas sin escalar.
const signals = [
    ['de.bmw.infotainment.drivingexcitement.Efficiencytainment2', '1', {
        statusChargeOfBatteryHybrid: ['rs', 'displayChargingConditionHighVoltageStorage'],
        statusBatteryTemperature: ['rs', 'actualValueTemperatureHighVoltageStorage'],
        displayPowerDrive: ['s', 'quotaImmediateElectricEngineDriveRecuperation']
    }],
    ['de.bmw.infotainment.drivingexcitement.PredictiveThermalManagement', '1', {
        statusPredictiveThermalManagement: ['rs', 'statusVWM', 'statusRestrictionsVWM', 'statusFeedbackVWM'],
        statusHighVoltageBattery: ['rs', 'thermalStatusHighVoltageBatteryForFastCharging',
            'thermalPreconditioningDurationTempLow', 'thermalPreconditioningDurationTempHigh']
    }],
    ['de.bmw.infotainment.lsc.LSCDataSink', '1', {
        displayConditionHybrid: ['s', 'displayChargingconditionHighvoltageStorage'],
        dataRangeDisplay: ['s', 'dataRangeDisplayElectric', 'fadeoutRangeDisplayElectric', 'unitRangeDisplay']
    }],
    ['de.bmw.infotainment.KombiIF', '1', {
        displayRangeElectricVehicle: ['rs', 'displayRangeElectricVehicle'],
        statusConsumptionAverageElectricVehicle: ['r', 'consumptionAverageElectricVehicleBC1',
            'consumptionAverageElectricVehicleBC2', 'unitOfMeasurementConsumptionElectricVehicleBC']
    }],
    ['de.bmw.infotainment.navigation.positioning.Positioning', 'Main_Instance', {
        rawPositionData: ['rs', 'fixType', 'position.heightValid', 'position.height.rawLengthMeter',
            'position.coordinatesValid', 'position.latitude', 'position.longitude']
    }],
    ['de.bmw.infotainment.telematic.journeyhistory.BcPersonal', '1', {
        driveSegment: ['r', 'bcBeDurationDrive', 'bcBeTripDistanceKm', 'bcBeConsElectricVisible', 'bcBeSpeedAvgDrive']
    }],
    ['de.bmw.infotainment.resetlogic.ResetLogic3', '1', {
        bcDataAll: ['rs', 'activeResetLogic', 'bcUnits.tachoDigital', 'bcUnits.averageConsumptionElectric',
            'bcUnits.currentConsumptionElectric', 'bcData3[].resetOption', 'bcData3[].counterDistance',
            'bcData3[].consumptionElectricAverageDigit', 'bcData3[].consumptionElectricCurrentDigit',
            'bcData3[].speedAverage', 'bcData3[].dateTimeTrip.day', 'bcData3[].dateTimeTrip.hour',
            'bcData3[].dateTimeTrip.minute', 'bcData3[].dateTimeTrip.second']
    }],
    ['de.bmw.infotainment.vehicle.Vehicle2', '1', {
        statusCarSpeed2: ['rs', 'speedVehicleCentreOfGravity'],
        highVoltageStorageInfoToExternal: ['s', 'energyDischargeHighVoltageStoragePresentDynamic',
            'energyDischargeHighVoltageStorageMaximalDynamic']
    }],
    ['de.bmw.infrastructure.EnvironmentalInformation', '1', {
        ExteriorTemperature: ['s', 'temperatureExterior']
    }],
    ['de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager',
        'AndroidAutoProjectedManagerInst1', {
            isVideoStreaming: ['rs']
    }]
];

const resetOptionIds = { DEFAULT: 0, INDIVIDUAL: 1, REFUEL: 2, CHARGE: 3, STARTOFDRIVING: 4, LONGTERM: 5, AVERAGE: 6 };
const journeyPeriods = { 1: 'individual', 3: 'charge', 4: 'trip', 5: 'factory' };

function sample(value, paths) {
    if (!paths.length) {
        return typeof value === 'boolean' || value === 0 || value === 1 ? { value: Boolean(value) } : null;
    }
    const result = {};
    for (const path of paths) {
        const field = path.split('.').reduce((object, key) => object == null ? undefined : object[key], value);
        if (Number.isFinite(field) || typeof field === 'boolean' ||
            (typeof field === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(field))) {
            result[path] = field;
        }
    }
    if (Number.isInteger(result.statusVWM)) {
        const raw = result.statusVWM;
        // Hmi8 uses bit 0 for the status-bar icon and treats 61–63 as unavailable.
        result.preconditioningActive = raw >= 0 && raw < 61 ? Boolean(raw & 1) : null;
    }
    return Object.keys(result).length ? result : null;
}

function sampleJourney(value, paths) {
    const prefix = 'bcData3[].';
    const result = sample(value, paths.filter((path) => !path.startsWith(prefix))) || {};
    const entries = value && value.bcData3;
    if (Array.isArray(entries)) {
        const active = result.activeResetLogic;
        const members = paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
        for (const entry of entries.slice(0, 5)) {
            const fields = sample(entry, members);
            if (!fields) continue;
            // Hmi8 feeds the live consumption from the entry selected by activeResetLogic.
            const option = Number.isInteger(fields.resetOption) ? fields.resetOption : resetOptionIds[fields.resetOption];
            if (Number.isInteger(active) && active === option && fields.consumptionElectricCurrentDigit !== undefined) {
                result['active.consumptionElectricCurrentDigit'] = fields.consumptionElectricCurrentDigit;
            }
            const period = journeyPeriods[option];
            if (!period) continue;
            for (const key of Object.keys(fields)) {
                if (key !== 'resetOption') result[period + '.' + key] = fields[key];
            }
        }
    }
    return Object.keys(result).length ? result : null;
}

function start(builders, schedule = setTimeout, cancel = clearTimeout, options = {}) {
    const samples = new Map(), sessions = new Set();
    const timeoutMs = options.timeoutMs || 8000, retryMs = options.retryMs || 2000;
    let stopped = false;
    function later(session, work, delay, custom) {
        const run = () => { session.timers.delete(id); if (session.active && !stopped) work(); };
        const id = (custom ? schedule : setTimeout)(run, delay);
        session.timers.set(id, custom ? cancel : clearTimeout);
        return id;
    }
    function bounded(session, work, late) {
        return new Promise((resolve, reject) => {
            let done = false;
            const abort = () => {
                if (done) return;
                done = true; clearTimeout(timer); session.pending.delete(abort);
                reject(new Error('timeout'));
            };
            const timer = setTimeout(abort, timeoutMs);
            session.pending.add(abort);
            let result;
            try {
                if (!session.active || stopped) throw new Error('cancelled');
                result = work();
            } catch (error) { result = Promise.reject(error); }
            Promise.resolve(result).then(value => {
                if (done) { if (late) late(value); return; }
                done = true; clearTimeout(timer); session.pending.delete(abort); resolve(value);
            }, error => {
                if (done) return;
                done = true; clearTimeout(timer); session.pending.delete(abort); reject(error);
            });
        });
    }
    function dispose(proxy) {
        return Promise.resolve().then(() => {
            if (typeof proxy.shutdown === 'function') return proxy.shutdown();
            if (typeof proxy.dispose === 'function') return proxy.dispose();
        }).then(() => true, () => false);
    }
    function unsubscribe(attribute, id) {
        return Promise.resolve().then(() => attribute.unsubscribe(id)).then(() => true, () => false);
    }
    function close(session) {
        if (session.closing) return session.closing;
        session.active = false;
        session.timers.forEach((clear, id) => clear(id)); session.timers.clear();
        session.pending.forEach(abort => abort());
        session.closing = Promise.all(session.subscriptions.map(([attribute, id]) => unsubscribe(attribute, id)))
            .then(results => {
                if (results.some(ok => !ok)) session.cleanupFailed = true;
                return session.proxy ? dispose(session.proxy) : true;
            })
            .then(ok => { if (!ok) session.cleanupFailed = true; sessions.delete(session); });
        return session.closing;
    }
    function reconnect(session, phase) {
        if (!session.active || stopped) return;
        for (const name of Object.keys(session.fields)) {
            if (samples.get(name).status !== 'sample') samples.set(name, { status: 'error', phase });
        }
        // Wait for native shutdown before replacing a generation. Never accumulate proxies.
        close(session).then(() => {
            if (stopped || session.cleanupFailed) return;
            const waiting = { active: true, timers: new Map(), pending: new Set(), subscriptions: [] };
            sessions.add(waiting);
            later(waiting, () => {
                sessions.delete(waiting);
                connect(session.service, session.instance, session.fields);
            }, retryMs);
        });
    }
    function observe(session, attribute, [mode, ...paths], signal) {
        const period = signal === 'statusCarSpeed2' ? 2000 : signal === 'statusHighVoltageBattery' ? 5000 : 10000;
        const readable = mode.includes('r');
        let notifications = 0;
        const active = () => session.active && !stopped;
        const receive = value => {
            if (!active()) return;
            const fields = signal === 'bcDataAll' ? sampleJourney(value, paths) : sample(value, paths);
            samples.set(signal, { status: fields ? 'sample' : 'empty', sampledAt: Date.now(),
                freshForMs: readable ? period * 3 : undefined, fields });
        };
        const fail = phase => {
            if (active() && samples.get(signal).status !== 'sample') samples.set(signal, { status: 'error', phase });
        };
        async function read() {
            if (!active()) return;
            const previous = notifications;
            try {
                const value = await bounded(session, () => attribute.getValue());
                if (previous === notifications) receive(value);
            } catch (error) {
                if (previous === notifications) fail('getter');
                if (error.message === 'timeout') return reconnect(session, 'getter');
            }
            if (active()) later(session, read, period, true);
        }
        async function subscribe() {
            try {
                if (!attribute || typeof attribute.unsubscribe !== 'function') throw new Error('subscribe');
                const id = await bounded(session, () => attribute.subscribe(value => {
                    notifications++; receive(value);
                }), id => unsubscribe(attribute, id));
                if (!active()) return unsubscribe(attribute, id);
                session.subscriptions.push([attribute, id]);
            } catch (error) {
                fail('subscribe');
                if (error.message === 'timeout') return reconnect(session, 'subscribe');
                if (active()) later(session, subscribe, retryMs);
            }
        }
        if (mode.includes('s')) subscribe();
        if (readable) read();
    }
    async function connect(service, instance, fields) {
        const session = { service, instance, fields, active: true, timers: new Map(), pending: new Set(), subscriptions: [] };
        sessions.add(session);
        for (const name of Object.keys(fields)) if (!samples.has(name)) samples.set(name, { status: 'no-sample' });
        try {
            const proxy = await bounded(session, () => builders.buildTypedProxy(service, instance), dispose);
            session.proxy = proxy;
            if (!session.active || stopped) return dispose(proxy);
            await bounded(session, () => proxy.init());
            await bounded(session, () => proxy.waitUntilAvailable());
            if (!session.active || stopped) return;
            for (const name of Object.keys(fields)) observe(session, proxy[name], fields[name], name);
        } catch (_) { reconnect(session, 'proxy'); }
    }
    for (const [service, instance, fields] of signals) connect(service, instance, fields);
    return {
        snapshot: () => Array.from(samples, ([signal, result]) => ({ signal, ...result })),
        stop() {
            if (stopped) return;
            stopped = true;
            sessions.forEach(close);
        }
    };
}

function report(builders, endpoint = '/run/javi-carlab/telemetry.sock') {
    const power = createPowerProbe(builders);
    let probe;
    let preconditioning;
    let socket;
    let timer;

    function send() {
        if (!probe) return;
        if (!socket) {
            const peer = net.createConnection(endpoint);
            socket = peer;
            const commands = consumeCommands((command) => {
                if (peer === socket && preconditioning) preconditioning.command(command).catch(() => {});
            });
            peer.on('data', (chunk) => { if (peer !== socket || !commands(chunk)) peer.destroy(); });
            peer.on('error', () => {});
            peer.setTimeout(5000, () => peer.destroy());
            peer.on('connect', () => { if (socket === peer) send(); });
            peer.on('close', () => { if (socket === peer) socket = undefined; });
            return;
        }
        if (!socket.connecting && !socket.destroyed && !socket.bufferSize) {
            socket.write(JSON.stringify({ version: 1, records: probe.snapshot().concat(power.snapshot()),
                preconditioning: preconditioning.snapshot() }) + '\n');
        }
    }

    return {
        show(on) {
            if (on && !probe) {
                probe = start(builders);
                preconditioning = createPreconditioning(builders);
                power.show(true);
                timer = setInterval(send, 1000);
                send();
            } else if (!on && probe) {
                clearInterval(timer);
                power.show(false);
                probe.stop();
                preconditioning.stop(); preconditioning = undefined;
                probe = undefined;
                if (socket) { socket.destroy(); socket = undefined; }
            }
        }
    };
}

module.exports = { signals, start, report };
