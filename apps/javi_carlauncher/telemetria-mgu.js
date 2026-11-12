'use strict';

const net = require('net');
const { createPowerProbe } = require('./potencia-hv.js');

// Candidatos del catálogo MGU21. Esta sonda conserva las lecturas sin escalar.
const signals = [
    ['de.bmw.infotainment.drivingexcitement.Efficiencytainment2', '1', {
        statusChargeOfBatteryHybrid: ['rs', 'displayChargingConditionHighVoltageStorage'],
        statusBatteryTemperature: ['r', 'actualValueTemperatureHighVoltageStorage'],
        displayPowerDrive: ['s', 'quotaImmediateElectricEngineDriveRecuperation']
    }],
    ['de.bmw.infotainment.drivingexcitement.PredictiveThermalManagement', '1', {
        statusPredictiveThermalManagement: ['rs', 'statusVWM', 'statusRestrictionsVWM', 'statusFeedbackVWM'],
        statusHighVoltageBattery: ['r', 'thermalStatusHighVoltageBatteryForFastCharging',
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
        rawPositionData: ['r', 'fixType', 'position.heightValid', 'position.height.rawLengthMeter']
    }],
    ['de.bmw.infotainment.telematic.journeyhistory.BcPersonal', '1', {
        driveSegment: ['r', 'bcBeDurationDrive', 'bcBeTripDistanceKm', 'bcBeConsElectricVisible', 'bcBeSpeedAvgDrive']
    }],
    ['de.bmw.infotainment.resetlogic.ResetLogic3', '1', {
        bcDataAll: ['r', 'bcUnits.tachoDigital', 'bcUnits.averageConsumptionElectric',
            'bcUnits.currentConsumptionElectric', 'bcData3[].resetOption', 'bcData3[].counterDistance',
            'bcData3[].consumptionElectricAverageDigit', 'bcData3[].consumptionElectricCurrentDigit']
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

const journeyPeriods = {
    1: 'individual', 3: 'charge', 4: 'trip', 5: 'factory',
    INDIVIDUAL: 'individual', CHARGE: 'charge', STARTOFDRIVING: 'trip', LONGTERM: 'factory'
};

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
        const members = paths.filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length));
        for (const entry of entries.slice(0, 5)) {
            const fields = sample(entry, members);
            const period = fields && journeyPeriods[fields.resetOption];
            if (!period) continue;
            for (const key of Object.keys(fields)) {
                if (key !== 'resetOption') result[period + '.' + key] = fields[key];
            }
        }
    }
    return Object.keys(result).length ? result : null;
}

function start(builders, schedule = setTimeout, cancel = clearTimeout) {
    const samples = new Map();
    const subscriptions = [];
    const proxies = [];
    const timers = new Set();
    let stopped = false;

    function dispose(proxy) {
        if (typeof proxy.dispose === 'function') {
            return Promise.resolve().then(() => proxy.dispose()).catch(() => undefined);
        }
    }

    function unsubscribe(attribute, id) {
        return Promise.resolve().then(() => attribute.unsubscribe(id)).catch(() => undefined);
    }

    function stop() {
        if (stopped) return;
        stopped = true;
        timers.forEach(cancel);
        timers.clear();
        Promise.all(subscriptions.map(([attribute, id]) => unsubscribe(attribute, id)))
            .then(() => proxies.forEach(dispose));
    }

    function observe(attribute, [mode, ...paths], signal) {
        const period = signal === 'statusCarSpeed2' ? 2000 : 10000;
        const readable = mode.includes('r');
        let notifications = 0;
        const receive = (value) => {
            if (stopped) return;
            const fields = signal === 'bcDataAll' ? sampleJourney(value, paths) : sample(value, paths);
            samples.set(signal, { status: fields ? 'sample' : 'empty', sampledAt: Date.now(),
                freshForMs: readable ? period * 3 : undefined, fields });
        };
        const fail = (phase) => {
            if (!stopped && samples.get(signal).status !== 'sample') {
                samples.set(signal, { status: 'error', phase });
            }
        };
        async function read() {
            if (stopped) return;
            const previous = notifications;
            try {
                const value = await attribute.getValue();
                if (previous === notifications) receive(value);
            } catch (_) {
                if (previous === notifications) fail('getter');
            }
            if (stopped) return;
            const timer = schedule(() => {
                timers.delete(timer);
                read();
            }, period);
            timers.add(timer);
        }
        if (mode.includes('s')) {
            Promise.resolve().then(async () => {
                if (stopped) return;
                if (!attribute || typeof attribute.unsubscribe !== 'function') throw new Error();
                const id = await attribute.subscribe((value) => {
                    notifications++;
                    receive(value);
                });
                if (stopped) return unsubscribe(attribute, id);
                subscriptions.push([attribute, id]);
            }).catch(() => fail('subscribe'));
        }
        if (readable) read();
    }

    async function connect(service, instance, fields) {
        const names = Object.keys(fields);
        for (const name of names) samples.set(name, { status: 'no-sample' });
        try {
            const proxy = await builders.buildTypedProxy(service, instance);
            if (stopped) return dispose(proxy);
            proxies.push(proxy);
            await proxy.init();
            if (stopped) return;
            await proxy.waitUntilAvailable();
            if (stopped) return;
            for (const name of names) observe(proxy[name], fields[name], name);
        } catch (_) {
            if (!stopped) {
                for (const name of names) samples.set(name, { status: 'error', phase: 'proxy' });
            }
        }
    }

    for (const [service, instance, fields] of signals) connect(service, instance, fields);
    return { snapshot: () => Array.from(samples, ([signal, result]) => ({ signal, ...result })), stop };
}

function report(builders, endpoint = '/run/javi-carlab/telemetry.sock') {
    const power = createPowerProbe(builders);
    let probe;
    let socket;
    let timer;

    function send() {
        if (!probe) return;
        if (!socket) {
            const peer = net.createConnection(endpoint);
            socket = peer;
            peer.on('error', () => {});
            peer.on('connect', () => { if (socket === peer) send(); });
            peer.on('close', () => { if (socket === peer) socket = undefined; });
            return;
        }
        if (!socket.connecting && !socket.destroyed && !socket.bufferSize) {
            socket.write(JSON.stringify({ version: 1, records: probe.snapshot().concat(power.snapshot()) }) + '\n');
        }
    }

    return {
        show(on) {
            if (on && !probe) {
                probe = start(builders);
                power.show(true);
                timer = setInterval(send, 1000);
                send();
            } else if (!on && probe) {
                clearInterval(timer);
                power.show(false);
                probe.stop();
                probe = undefined;
                if (socket) { socket.destroy(); socket = undefined; }
            }
        }
    };
}

module.exports = { signals, start, report };
