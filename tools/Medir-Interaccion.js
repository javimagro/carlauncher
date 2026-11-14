'use strict';

// Local CPU benchmark, compatible with the installed Node 8 runtime. No network/car.
const { createNavigationUI } = require('../native/javi-carlab/navigation-ui');
const { createRadioUI } = require('../native/javi-carlab/radio-ui');
const elapsed = (t) => { const d = process.hrtime(t); return d[0] * 1000 + d[1] / 1e6; };
function measure(fn) {
    for (let i = 0; i < 30; i++) fn();
    const times = [];
    for (let i = 0; i < 300; i++) { const t = process.hrtime(); fn(); times.push(elapsed(t)); }
    times.sort((a, b) => a - b);
    return { p50: times[150], p95: times[285], max: times[299] };
}
const ui = createNavigationUI({}, () => {}), radio = createRadioUI({});
try {
    const points = Array.from({ length: 12000 }, (_, i) => ({ latitude: 40 + i / 100000, longitude: -3 + i / 100000 }));
    const nav = { state: 'active', points, destinations: [], segments: [], route: { key: '1:1' },
        controls: { request: 0, status: 'preview', busy: false, plan: { key: '1:1' }, stops: [] } };
    ui.state.panel = 'route';
    const station = (i) => ({ key: String(i), id: i, memoryKey: String(i), name: 'Station ' + i, title: '', artist: '',
        list: 2, position: i, band: 'DAB', frequency: null, category: 'music', favorite: i % 2 === 0, receptionLost: false, programme: null });
    radio.receive({ version: 1, stations: Array.from({ length: 1500 }, (_, i) => station(i)), current: null,
        active: false, sourceKnown: true, loading: false, listError: '', logo: null, artwork: null, result: null }, Date.now());
    radio.state.filters = ['favorites'];
    console.log(JSON.stringify({ node: process.version, platform: process.platform, routePoints: points.length,
        navigationMs: measure(() => ui.update(nav, { location: points[0] }, true)), stations: 1500,
        radioFavoritesMs: measure(() => radio.rows()) }, null, 2));
} finally { ui.close(); radio.close(); }
