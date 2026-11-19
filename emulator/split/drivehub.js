'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const [socket, store, mode, telemetry] = process.argv.slice(2);
const native = '../../native/javi-carlab/';
const record = require(native + 'vendor/kit_record.js');
const createSession = require(native + 'drivehub-session.js');
const { width, height } = require(native + 'drivehub-state.js');
const { RenderClient } = require(path.join(store, 'native/mgu-render/js/mgu_render_client.js'));
const { createActions, contracts } = require('../../apps/javi_carlauncher/navegacion-acciones');
const profile = process.env.LOCALAPPDATA || os.homedir();
const ffmpeg = process.env.JAVI_TDT_FFMPEG || 'ffmpeg';
const ffplay = process.env.JAVI_ASSISTANT_FFPLAY;
const microphone = process.env.JAVI_ASSISTANT_PC_MIC;
const tdtDirectory = path.join(profile, mode === 'live' ? 'BMWLauncher-TDT' : 'BMWLauncher-TDT-Demo');
fs.mkdirSync(tdtDirectory, { recursive: true });

const fixture = {
    weather: {
        name: 'Madrid', temp: 13, feels: 11, high: 13, low: 11, probability: 100, rain: 0.8,
        wind: 18, direction: 175, sunrise: '07:56', sunset: '17:59', kind: 'rain',
        hours: [
            { time: '16:00', temp: 12, probability: 100, kind: 'rain' },
            { time: '17:00', temp: 12, probability: 100, kind: 'rain' },
            { time: '18:00', temp: 11, probability: 98, kind: 'rain' }
        ],
        dailyRain: ['mié.', 'jue.', 'vie.', 'sáb.', 'dom.', 'lun.', 'mar.'].map((label, i) => ({
            label, date: (11 + i) + '/11', mm: [3.4, 5.1, 0.3, 0, 12.1, 4.3, 2.3][i],
            hours: Array.from({ length: 24 }, (_, hour) => ({
                label: String(hour).padStart(2, '0'),
                mm: Math.round(Math.max(0, Math.sin((hour + i * 3) / 4 - 2.8)) * (i + 1) * 10) / 10
            }))
        }))
    },
    news: [
        {
            url: 'fixture:1', source: 'Ejemplo de noticias', title: 'La previsión de lluvia cambia los planes del fin de semana',
            summary: 'Los chubascos volverán por la tarde y se extenderán de oeste a este. La previsión por horas permite consultar cómo evoluciona la precipitación durante el día. En las zonas de montaña se esperan los acumulados más altos. Las temperaturas descenderán ligeramente y la situación tenderá a estabilizarse al final del domingo.'
        },
        {
            url: 'fixture:2', source: 'Ejemplo de tecnología', title: 'Una red de recarga incorpora nuevos puntos en las principales carreteras',
            summary: 'Las nuevas estaciones se sitúan cerca de las vías principales. Cada área dispone de varias tomas y permite consultar su disponibilidad antes de llegar.'
        },
        {
            url: 'fixture:3', source: 'Ejemplo de motor', title: 'Cómo cambia la autonomía de un eléctrico en los viajes de invierno',
            summary: 'La velocidad, la climatización y las condiciones de la carretera influyen en el consumo. Un trayecto con lluvia y bajas temperaturas exige prever un margen de batería.'
        }
    ]
};

const gpu = new RenderClient('javi_carlauncher_preview', console, { socket, kit: record });
let voiceGuidance = true;
const guidanceOptions = Object.fromEntries(Object.keys(contracts.guidance.attributes).map((key) => [key, null]));
const guidance = createActions({ async buildAndInitTypedProxy(name) {
    if (name !== contracts.guidance.name) throw new Error('BMW_NO_DISPONIBLE');
    return { dispose() {}, voiceGuidanceEnabled: {
        async setValue(value) { voiceGuidance = value; },
        async getValue() { return voiceGuidance; }
    } };
} });
function reportNavigation() {
    session.navigation({ version: 1, at: Date.now(), state: 'unavailable', theme: 'auto', route: null, destinations: [], segments: [],
        destinationsKnown: false, electricRouting: null, controls: guidance.snapshot(),
        presentation: { options: { ...guidanceOptions, voiceGuidanceEnabled: voiceGuidance }, available: true,
            hud: { ready: null, layout: null, mapSelected: null }, views: [] } });
}
const session = createSession(gpu, {
    diagnostics: telemetry === 'telemetry',
    fixture: mode === 'live' ? undefined : fixture,
    assistantDirectory: path.join(profile, 'BMWLauncher-Assistant'),
    navigationFile: path.join(profile, 'BMWLauncher-Navigation.json'),
    tdtDirectory,
    tdtMediaset: require(native + 'tdt-mediaset').startMediaset,
    assistantAudio: ffplay && {
        ffmpeg,
        playback: { command: ffplay, drain: true, args: ['-nodisp', '-autoexit', '-loglevel', 'error', '-f', 's16le', '-ar', '48000', '-ch_layout', 'stereo', '-i', 'pipe:0'] },
        capture: microphone && { command: ffmpeg, args: ['-loglevel', 'error', '-f', 'dshow', '-i', 'audio=' + microphone, '-ar', '24000', '-ac', '1', '-f', 's16le', 'pipe:1'] }
    },
    tdtPlayback: { ffmpeg, preview: true },
    navigationCommand(command) {
        if (command.action !== 'guidance-setting' || command.setting !== 'voiceGuidanceEnabled') return false;
        guidance.command(command).then(reportNavigation);
        return true;
    },
    onExit: () => session.show(false),
    area: () => ({ x: 0, y: 0, w: width, h: height, scale: 1 })
});
session.setHome('ready');
session.show(true);
reportNavigation();
const navigationTimer = setInterval(reportNavigation, 1000);
navigationTimer.unref();
if (telemetry === 'telemetry') {
    const samples = {
        statusChargeOfBatteryHybrid: { displayChargingConditionHighVoltageStorage: 182 },
        displayRangeElectricVehicle: { displayRangeElectricVehicle: 431 },
        ExteriorTemperature: { temperatureExterior: 112 },
        statusBatteryTemperature: { actualValueTemperatureHighVoltageStorage: 69 },
        statusConsumptionAverageElectricVehicle: {
            consumptionAverageElectricVehicleBC1: 170, consumptionAverageElectricVehicleBC2: 180,
            unitOfMeasurementConsumptionElectricVehicleBC: 'VERBRAUCH_IN_KWH__S__100KM'
        },
        dataRangeDisplay: {
            dataRangeDisplayElectric: 254, unitRangeDisplay: 'KILOMETER', fadeoutRangeDisplayElectric: 0
        },
        driveSegment: { bcBeTripDistanceKm: 310, bcBeDurationDrive: 2150, bcBeConsElectricVisible: 2700, bcBeSpeedAvgDrive: 2750 },
        bcDataAll: {
            'bcUnits.tachoDigital': 'KILOMETERS', 'bcUnits.averageConsumptionElectric': 'KWH',
            'bcUnits.currentConsumptionElectric': 'KWH', 'active.consumptionElectricCurrentDigit': 65745,
            'trip.counterDistance': 345, 'trip.consumptionElectricAverageDigit': 65753, 'trip.speedAverage': 425,
            'trip.dateTimeTrip.day': 0, 'trip.dateTimeTrip.hour': 1, 'trip.dateTimeTrip.minute': 7,
            'trip.dateTimeTrip.second': 0, 'charge.counterDistance': 523, 'charge.consumptionElectricAverageDigit': 65763,
            'individual.counterDistance': 4567, 'individual.consumptionElectricAverageDigit': 65741,
            'factory.counterDistance': 450340, 'factory.consumptionElectricAverageDigit': 65718
        },
        rawPositionData: { 'position.heightValid': true, 'position.height.rawLengthMeter': 635 },
        statusHighVoltageBattery: { thermalStatusHighVoltageBatteryForFastCharging: 2 },
        statusPredictiveThermalManagement: { preconditioningActive: true, statusVWM: 1 },
        isVideoStreaming: { value: false },
        statusCarSpeed2: { speedVehicleCentreOfGravity: 1280 }
    };
    const sampledAt = Date.now();
    session.telemetry(Object.entries(samples).map(([signal, fields]) => ({ signal, status: 'sample', sampledAt, fields })));
}
process.on('message', (message) => { if (message === 'open') session.show(true); });
process.on('disconnect', () => { clearInterval(navigationTimer); guidance.stop(); session.close(); });
gpu.connect();
