'use strict';

const path = require('node:path');
const [socket, store, mode, telemetry] = process.argv.slice(2);
const native = '../../native/javi-carlab/';
const record = require(native + 'vendor/kit_record.js');
const createSession = require(native + 'drivehub-session.js');
const { width, height } = require(native + 'drivehub-state.js');
const { RenderClient } = require(path.join(store, 'native/mgu-render/js/mgu_render_client.js'));

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
const session = createSession(gpu, {
    diagnostics: telemetry === 'telemetry',
    fixture: mode === 'live' ? undefined : fixture,
    tdtPlayback: { ffmpeg: process.env.JAVI_TDT_FFMPEG || 'ffmpeg', preview: true },
    onExit: () => session.show(false),
    area: () => ({ x: 0, y: 0, w: width, h: height, scale: 1 })
});
session.setHome('ready');
session.show(true);
if (telemetry === 'telemetry') {
    const samples = {
        statusChargeOfBatteryHybrid: { displayChargingConditionHighVoltageStorage: 68 },
        dataRangeDisplay: {
            dataRangeDisplayElectric: 254, unitRangeDisplay: 'KILOMETER', fadeoutRangeDisplayElectric: 0
        },
        driveSegment: { bcBeTripDistanceKm: 310, bcBeDurationDrive: 2150, bcBeConsElectricVisible: 2700, bcBeSpeedAvgDrive: 2750 },
        statusPredictiveThermalManagement: { preconditioningActive: true, statusVWM: 1 },
        isVideoStreaming: { value: false },
        statusCarSpeed2: { speedVehicleCentreOfGravity: 1280 }
    };
    const sampledAt = Date.now();
    session.telemetry(Object.entries(samples).map(([signal, fields]) => ({ signal, status: 'sample', sampledAt, fields })));
}
process.on('disconnect', () => session.close());
gpu.connect();
