'use strict';
// Synthetic forecasts: no network and no car access. Uses the production card.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Recorder, play } = require('../emulator/split/software-renderer');
const { Canvas } = require('../native/javi-carlab/vendor/kit_canvas');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { loadArtwork, parseWeather } = require('../native/javi-carlab/drivehub-data');
const { cards } = require('../native/javi-carlab/drivehub-state');
const out = path.resolve('dist/weather-preview'); fs.mkdirSync(out, { recursive: true });
const hours = Array.from({ length: 24 }, (_, i) => '2026-11-13T' + String(i).padStart(2, '0') + ':00');
const forecast = parseWeather({ current: { time: hours[13], temperature_2m: 18, apparent_temperature: 17, weather_code: 3, is_day: 1,
    precipitation: .2, wind_speed_10m: 12, wind_direction_10m: 225 },
    hourly: { time: hours, temperature_2m: hours.map(() => 17), weather_code: hours.map(() => 3), is_day: hours.map(() => 1),
        precipitation: hours.map((_, i) => i > 14 && i < 20 ? .8 : .1), precipitation_probability: hours.map(() => 40) },
    daily: { time: ['2026-11-13'], temperature_2m_max: [21], temperature_2m_min: [12], sunrise: ['2026-11-13T07:58'], sunset: ['2026-11-13T17:59'], precipitation_sum: [4.7] }
}, 'Ubicación actual');
const art = loadArtwork(); let reference;
for (const status of ['location', 'loading', 'ready', 'stale', 'offline', 'rain']) {
    const data = { city: 'Ubicación actual', weatherStatus: status, weather: ['location','loading'].includes(status) ? undefined : forecast,
        telemetry: [], diagnostics: true, home: 'ready', energy: [] };
    const cv = new Recorder(1960,520), surface = new Canvas(1960,520);
    drawHome(cv, { selected: 2, weatherPage: status === 'rain' ? 'rain' : 'summary', weatherDay: 0, article: 0 }, cards[2].x, data, art, 1000);
    play(cv.words(), surface);
    if (!reference) reference = new Uint8Array(surface.d);
    else for (let y = 0; y < 520; y++) assert.deepEqual(surface.d.subarray(y * 1960 * 4, (y * 1960 + 1050) * 4), reference.subarray(y * 1960 * 4, (y * 1960 + 1050) * 4));
    fs.writeFileSync(path.join(out, status + '.png'), surface.png(6));
}
console.log('6 capturas sintéticas: GPS, carga, tiempo actual, actualización, desconexión y lluvia. Mapa y barra sin cambios.');
