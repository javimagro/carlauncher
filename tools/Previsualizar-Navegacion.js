'use strict';

// Reproducible views, using only synthetic vehicle/routes/results. --online
// fetches the one visible Madrid map viewport, cached for at least seven days.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { Recorder, play } = require('../emulator/split/software-renderer');
const { Canvas } = require('../native/javi-carlab/vendor/kit_canvas');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { loadArtwork } = require('../native/javi-carlab/drivehub-data');
const { createNavigationUI } = require('../native/javi-carlab/navigation-ui');
const { vehicleReadings } = require('../native/javi-carlab/vehicle-readings');
const download = require('../native/javi-carlab/drivehub-network');
const output = path.resolve('dist/navigation-preview');
const online = process.argv.includes('--online');
fs.mkdirSync(output, { recursive: true });
const point = { latitude: 40.4168, longitude: -3.7038 };
const samples = {
    statusChargeOfBatteryHybrid: { displayChargingConditionHighVoltageStorage: 182 },
    displayRangeElectricVehicle: { displayRangeElectricVehicle: 431 },
    ExteriorTemperature: { temperatureExterior: 112 },
    statusBatteryTemperature: { actualValueTemperatureHighVoltageStorage: 83 },
    rawPositionData: { 'position.coordinatesValid': true, 'position.latitude': point.latitude, 'position.longitude': point.longitude,
        'position.heightValid': true, 'position.height.rawLengthMeter': 635 }
};
const telemetry = Object.keys(samples).map((signal) => ({ signal, fields: samples[signal], status: 'sample', sampledAt: 1000 }));
const vehicle = vehicleReadings(new Map(telemetry.map((r) => [r.signal, r])), 1000);
const address = { optionPOILocation: Object.assign({ coordinatesValid: true, name: 'Destino de prueba' }, point) };
const controls = { request: 1, busy: false, status: 'results', query: 'MADRID', error: '', selected: Object.assign({ name: 'Destino de prueba', address, phone: '', details: [] }, point),
    results: Array.from({ length: 8 }, (_, i) => ({ id: '1:' + i, name: 'Resultado de prueba ' + (i + 1), metres: 1000 * (i + 1), type: 'poi' })),
    stops: [Object.assign({ name: 'Cargador de prueba', charging: true }, point), Object.assign({ name: 'Destino de prueba', charging: false }, point)],
    plan: { charging: true, arrival: 15, metres: 50400, seconds: 2399 } };
const nav = { state: 'inactive', points: [], destinations: [], segments: [], theme: 'day', controls };
const ui = createNavigationUI({ get: online ? download : undefined, mapDirectory: path.join(os.tmpdir(), 'bmw-navigation-map-cache') }, () => {});
const data = { telemetry, home: 'ready', navigation: nav, navigationUi: ui, energy: [{ label: 'Ahora' }, { label: 'En la parada' }, { label: 'Tras recarga' }, { label: 'En destino' }] };
const art = loadArtwork();
async function main() {
    try {
        ui.update(nav, vehicle, online);
        const deadline = Date.now() + 45000;
        while (online && ui.tiles.status().loading && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
        let reference;
        for (const scenario of ['mapa', 'teclado', 'resultados', 'detalle', 'ruta', 'ajustes', 'guardados', 'noche', 'guiado']) {
            ui.state.panel = ({ teclado: 'search', resultados: 'search', detalle: 'detail', ruta: 'route', ajustes: 'settings', guardados: 'recent' })[scenario] || 'none';
            ui.state.theme = scenario === 'noche' ? 'night' : 'day'; ui.state.query = 'MADRID'; ui.state.keyboard = scenario === 'teclado';
            ui.state.recent = ['Destino de prueba', 'Madrid']; ui.state.controls = Object.assign({}, controls, { status: scenario === 'ruta' ? 'preview' : 'results' });
            if (scenario === 'guiado') {
                nav.state = 'active'; nav.points = [point, { latitude: point.latitude + .001, longitude: point.longitude + .001 }];
                nav.instruction = { kind: 'intersection', direction: 'RIGHT', road: 'Vía de prueba', metres: 200, exit: null };
                nav.destinations = [{ final: true, metres: 50400, seconds: 2399 }]; nav.segments = [{ name: 'Destino de prueba' }];
            }
            const cv = new Recorder(1960, 520), surface = new Canvas(1960, 520);
            drawHome(cv, { selected: 0, article: 0 }, 0, data, art, 1000); play(cv.words(), surface);
            if (!reference) reference = new Uint8Array(surface.d);
            else for (let y = 0; y < 520; y++) {
                assert.deepEqual(surface.d.subarray((y * 1960 + 1050) * 4, (y + 1) * 1960 * 4), reference.subarray((y * 1960 + 1050) * 4, (y + 1) * 1960 * 4), 'DriveHub cambia al abrir ' + scenario);
                if (y >= 480) assert.deepEqual(surface.d.subarray(y * 1960 * 4, (y * 1960 + 1042) * 4), reference.subarray(y * 1960 * 4, (y * 1960 + 1042) * 4), 'La barra cambia al abrir ' + scenario);
            }
            fs.writeFileSync(path.join(output, scenario + '.png'), surface.png(6));
        }
        console.log('9 capturas; DriveHub y barra inferior idénticos píxel a píxel. Mapa: ' + JSON.stringify(ui.tiles.status()));
    } finally { ui.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
