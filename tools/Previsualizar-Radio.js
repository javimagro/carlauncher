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
const { cards } = require('../native/javi-carlab/drivehub-state');
const out = path.resolve('dist/radio-preview'); fs.mkdirSync(out, { recursive: true });
const ui = createRadioUI(), art = loadArtwork();
const stations = ['Onda Cero', 'LOS40', 'Radio MARCA', 'Radio Nacional', 'Cadena SER', 'Radio Clásica'].map((name, i) => station({
    dataBaseIdentifier: i + 1, id: i + 100, positionNumber: i, waveBand: 1, stationLongName: name,
    frequencyKhz: 98500 + i * 200, isFavorite: i === 0 ? 1 : 0, pty: i === 2 ? 4 : 10, ptyTableType: 0,
    titleName: i === 0 ? 'Por fin · Datos de prueba' : 'Metadatos de prueba', artistName: '', receptionMode: 0,
    epgDayViewsList: i ? [] : [{ day: 1, eventsList: [{ eventName: 'Por fin · Datos de prueba', eventStartTime: { hour: 15, minute: 0, second: 0 }, eventEndTime: { hour: 19, minute: 0, second: 0 } }] }] }, 2, true));
const frame = { version: 1, at: 1000, available: true, loading: false, busy: false, sourceKnown: true, active: true,
    current: stations[0], stations, clock: 61200, result: null, listError: '', logo: null, artwork: null };
ui.receive(frame, 1000); ui.update(1000, true); ui.images.set('1', art('radio'));
const data = { city: 'Madrid', radio: ui, diagnostics: true, telemetry: [], home: 'ready', energy: [] };
let reference;
for (const scenario of ['reproduciendo', 'emisoras', 'favoritos', 'deportes', 'sin-senal', 'desconectada']) {
    ui.state.filters = []; ui.state.mode = scenario === 'emisoras' || scenario === 'favoritos' || scenario === 'deportes' ? 'list' : 'playing';
    if (scenario === 'favoritos') ui.filter(0);
    if (scenario === 'deportes') ui.filter(3);
    if (scenario === 'sin-senal') ui.receive(Object.assign({}, frame, { current: Object.assign({}, stations[0], { receptionLost: true }) }), 1000);
    if (scenario === 'desconectada') ui.receive(null, 1000);
    for (let n = 0; n < 12; n++) ui.update(1000 + n * 60, true);
    const cv = new Recorder(1960, 520), surface = new Canvas(1960, 520);
    drawHome(cv, { selected: 1, weatherPage: 'summary', article: 0 }, cards[1].x, data, art, 1600); play(cv.words(), surface);
    if (!reference) reference = new Uint8Array(surface.d);
    else for (let y = 0; y < 520; y++) assert.deepEqual(surface.d.subarray(y * 1960 * 4, (y * 1960 + 1050) * 4), reference.subarray(y * 1960 * 4, (y * 1960 + 1050) * 4), 'Radio altera el mapa/barra: ' + scenario);
    fs.writeFileSync(path.join(out, scenario + '.png'), surface.png(6));
}
ui.close(); console.log('6 capturas de Radio: emisoras, categorías, favoritos y estados. El mapa y la barra no cambian.');
