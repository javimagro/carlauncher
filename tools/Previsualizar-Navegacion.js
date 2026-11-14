'use strict';

// Synthetic UI only; never fetches or reads external map tiles.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Recorder, play } = require('../emulator/split/software-renderer');
const { Canvas } = require('../native/javi-carlab/vendor/kit_canvas');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { loadArtwork } = require('../native/javi-carlab/drivehub-data');
const { createNavigationUI } = require('../native/javi-carlab/navigation-ui');
const { vehicleReadings } = require('../native/javi-carlab/vehicle-readings');
const output = path.resolve('dist/navigation-preview');
if (process.argv.includes('--online')) throw new Error('Navegación BMW no usa mapas online');
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
    results: Array.from({ length: 8 }, (_, i) => ({ id: '1:' + i, name: 'Estación de prueba ' + (i + 1), metres: 1000 * (i + 1), type: 'charger',
        latitude: point.latitude + .02 * i, longitude: point.longitude + .04 * i, positionState: 'ready' })),
    stops: [{ name: 'Cargador de prueba', charging: true, latitude: 40.45, longitude: -3.65 }, { name: 'Destino de prueba', charging: false, latitude: 40.51, longitude: -3.53 }],
    plan: { key: '80:3', charging: true, arrival: 15, metres: 50400, seconds: 2399 } };
const nav = { state: 'inactive', points: [], destinations: [], segments: [], theme: 'day', controls };
const ui = createNavigationUI({}, () => {});
const data = { telemetry, home: 'ready', navigation: nav, navigationUi: ui, energy: [{ label: 'Ahora' }, { label: 'En la parada' }, { label: 'Tras recarga' }, { label: 'En destino' }] };
const art = loadArtwork();
async function main() {
    try {
        await new Promise((resolve) => require('../native/javi-carlab/navigation-icons').preload(resolve));
        ui.update(nav, vehicle, true);
        let reference;
        const scenarios = ['mapa', 'teclado', 'resultados', 'cargadores-esperando', 'cargadores-error', 'cargadores-vacio', 'cargadores', 'cargadores-noche', 'detalle', 'ruta', 'ruta-paradas', 'ruta-bateria', 'ajustes', 'guardados', 'noche', 'guiado', 'ensayo-marcadores', 'ensayo-ruta',
            'hud-cuadro', 'hud-cuadro-noche', 'hud-cuadro-sin-datos', 'hud-cuadro-error'];
        const realStatus = ui.tiles.status, realDraw = ui.tiles.draw;
        for (const scenario of scenarios) {
            Object.assign(nav, { state: 'inactive', points: [], route: null, instruction: null, destinations: [], segments: [], presentation: undefined });
            ui.tiles.status = realStatus; ui.tiles.draw = realDraw;
            ui.state.offset = 0; ui.state.routePage = 'summary'; ui.state.camera = null; ui.state.follow = true; ui.state.displayFeedback = '';
            ui.state.panel = ({ teclado: 'search', resultados: 'search', detalle: 'detail', ruta: 'route', ajustes: 'settings', guardados: 'recent' })[scenario] || 'none';
            ui.state.theme = scenario.indexOf('noche') >= 0 ? 'night' : 'day'; ui.state.query = 'MADRID'; ui.state.cursor = 6; ui.state.keyboard = scenario === 'teclado';
            ui.state.recent = ['Destino de prueba', 'Madrid']; ui.state.controls = Object.assign({}, controls, { status: scenario === 'ruta' ? 'preview' : 'results' });
            ui.state.searchKind = 'text';
            if (['cargadores-esperando', 'cargadores-error', 'cargadores-vacio'].includes(scenario)) {
                ui.state.panel = 'search'; ui.state.searchKind = 'chargers';
                Object.assign(ui.state.controls, { results: [], selected: null, plan: null, searchPhase: 'results',
                    status: scenario === 'cargadores-esperando' ? 'loading' : scenario === 'cargadores-error' ? 'error' : 'results',
                    error: scenario === 'cargadores-error' ? 'BMW_SEARCH_TIMEOUT' : '' });
            }
            if (['cargadores', 'cargadores-noche', 'ensayo-marcadores'].includes(scenario)) {
                ui.state.panel = 'search'; ui.state.searchKind = 'chargers'; ui.state.focus = 'result:1:1';
            } else ui.state.focus = -1;
            if (scenario === 'detalle') ui.state.controls.selected = Object.assign({}, controls.selected, { type: 'charger', phone: 'Teléfono de prueba', details: ['Ubicación facilitada por BMW'] });
            if (scenario.indexOf('ruta-') === 0) { ui.state.panel = 'route'; ui.state.routePage = scenario === 'ruta-paradas' ? 'stops' : 'battery'; }
            if (scenario.indexOf('hud-cuadro') === 0) {
                ui.state.panel = 'guidance-displays';
                const known = scenario !== 'hud-cuadro-sin-datos', settings = {};
                require('../native/javi-carlab/navigation-displays').settings.forEach((s, i) => { settings[s[0]] = known ? i !== 2 : null; });
                nav.state = known ? 'active' : 'unavailable';
                nav.presentation = { options: settings, available: known, hud: { ready: known ? true : null, mapSelected: null, layout: null },
                    views: known ? [{ id: 'fixture-hud', target: 'HUD', type: 'HIGH_GUIDING', preview: false, consistent: true },
                        { id: 'fixture-ic', target: 'IC', type: 'JUNCTION_VIEW', preview: false, consistent: true }] : [] };
                if (scenario === 'hud-cuadro-error') ui.state.displayFeedback = 'BMW_GUIDANCE_SETTING_REJECTED';
            }
            if (scenario === 'guiado') {
                nav.state = 'active'; nav.points = [point, { latitude: point.latitude + .001, longitude: point.longitude + .001 }];
                nav.instruction = { kind: 'intersection', direction: 'RIGHT', road: 'Vía de prueba', metres: 200, exit: null };
                nav.destinations = [{ final: true, metres: 50400, seconds: 2399 }]; nav.segments = [{ name: 'Destino de prueba' }];
            }
            if (scenario === 'ensayo-ruta') {
                ui.state.panel = 'route'; ui.state.routePage = 'stops'; nav.state = 'active'; nav.route = { key: '80:3' };
                nav.points = [point, { latitude: 40.43, longitude: -3.73 }, controls.stops[0], { latitude: 40.48, longitude: -3.69 }, controls.stops[1]];
            }
            if (scenario.indexOf('ensayo-') === 0) {
                // Test fixture ONLY. Production createMap remains unavailable; no streets or map provider are invented.
                ui.tiles.status = () => ({ ready: true });
                ui.tiles.draw = (cv) => cv.text('ENSAYO GEOMÉTRICO · SIN CARTOGRAFÍA', 525, 90, 17, '#506278');
            }
            ui.state.nav = nav; ui.syncCamera(true);
            const cv = new Recorder(1960, 520), surface = new Canvas(1960, 520);
            drawHome(cv, { selected: 0, article: 0 }, 0, data, art, 1000); play(cv.words(), surface);
            if (!reference) reference = new Uint8Array(surface.d);
            else for (let y = 0; y < 520; y++) {
                assert.deepEqual(surface.d.subarray((y * 1960 + 1050) * 4, (y + 1) * 1960 * 4), reference.subarray((y * 1960 + 1050) * 4, (y + 1) * 1960 * 4), 'DriveHub cambia al abrir ' + scenario);
                if (y >= 480) assert.deepEqual(surface.d.subarray(y * 1960 * 4, (y * 1960 + 1042) * 4), reference.subarray(y * 1960 * 4, (y * 1960 + 1042) * 4), 'La barra cambia al abrir ' + scenario);
            }
            fs.writeFileSync(path.join(output, scenario + '.png'), surface.png(6));
        }
        ui.tiles.status = realStatus; ui.tiles.draw = realDraw;
        console.log(scenarios.length + ' capturas; DriveHub y barra inferior idénticos píxel a píxel. Mapa: ' + JSON.stringify(ui.tiles.status()));
    } finally { ui.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
