'use strict';
// Synthetic stations, no tuner access. The renderer and interactions are the production ones.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Recorder, play } = require('../emulator/split/software-renderer');
const { Canvas } = require('../native/javi-carlab/vendor/kit_canvas');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { loadArtwork } = require('../native/javi-carlab/drivehub-data');
const { createRadioUI } = require('../native/javi-carlab/radio-ui');
const { station } = require('../apps/javi_carlauncher/radio-datos');
const { cards, width, height, viewport } = require('../native/javi-carlab/drivehub-state');
const { createPhotoLoader } = require('../native/javi-carlab/photo-loader');
const out = path.resolve('dist/radio-preview', String(height)); fs.mkdirSync(out, { recursive: true });
const stations = ['Onda Cero', 'LOS40', 'Radio MARCA', 'Radio Nacional', 'Cadena SER', 'Radio Clásica'].map((name, i) => station({
    dataBaseIdentifier: i + 1, id: i + 100, positionNumber: i + 1, waveBand: 1, stationLongName: name,
    frequencyKhz: 98500 + i * 200, isFavorite: i === 0 ? 1 : 0, pty: i === 2 ? 4 : 10, ptyTableType: 0,
    titleName: i === 0 ? 'Por fin · Datos de prueba' : 'Metadatos de prueba', artistName: '', receptionMode: 0,
    epgDayViewsList: i ? [] : [{ day: 1, eventsList: [{ eventName: 'Por fin · Datos de prueba', eventStartTime: { hour: 15, minute: 0, second: 0 }, eventEndTime: { hour: 19, minute: 0, second: 0 } }] }] }, 2, true));
const frame = { version: 1, at: 1000, available: true, loading: false, busy: false, sourceKnown: true, active: true,
    current: stations[0], stations, clock: 61200, result: null, listError: '', logo: null, artwork: null };
async function run() {
    const photos = createPhotoLoader(), ui = createRadioUI({ photo: photos.load }), art = loadArtwork();
    try {
        const data = { city: 'Madrid', radio: ui, diagnostics: true, telemetry: [], home: 'ready', energy: [] };
        ui.receive(frame, 1000);
        let reference;
        for (const scenario of ['reproduciendo', 'emisoras', 'favoritos', 'deportes', 'sin-senal', 'desconectada']) {
            ui.state.filters = [];
            ui.state.mode = ['emisoras', 'favoritos', 'deportes'].includes(scenario) ? 'list' : 'playing';
            if (scenario === 'favoritos') ui.filter(0);
            if (scenario === 'deportes') ui.filter(3);
            if (scenario === 'sin-senal') ui.receive(Object.assign({}, frame, { current: Object.assign({}, stations[0], { receptionLost: true }) }), 1000);
            if (scenario === 'desconectada') ui.receive(null, 1000);
            const visible = ui.state.mode === 'list' ? ui.rows().slice(0, 4) : [ui.state.frame.current].filter(Boolean);
            for (let at = 0; at < 180 && visible.some((s) => !ui.stationImage(s)); at++) {
                ui.update(1100 + at * 10, true);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert(visible.every((s) => ui.stationImage(s)), 'Logo local ausente en ' + scenario);
            for (let n = 0; n < 12; n++) ui.update(3000 + n * 60, true);
            const cv = new Recorder(width, height), surface = new Canvas(width, height);
            drawHome(cv, { selected: 1, weatherPage: 'summary', article: 0 }, cards[1].x, data, art, 1600);
            play(cv.words(), surface);
            if (!reference) reference = new Uint8Array(surface.d);
            else for (let y = 0; y < height; y++) {
                const start = y * width * 4, end = start + viewport.x * 4;
                assert.deepEqual(surface.d.subarray(start, end), reference.subarray(start, end), 'Radio altera el mapa/barra: ' + scenario);
            }
            fs.writeFileSync(path.join(out, scenario + '.png'), surface.png(6));
        }
    } finally {
        ui.close();
        photos.close();
    }
    console.log('6 capturas de Radio con logos locales y datos simulados · ' + width + ' × ' + height);
}
run().catch((error) => { console.error(error.message); process.exitCode = 1; });
