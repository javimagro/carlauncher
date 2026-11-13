'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createActions, contracts, tripDefinition, routeOptions } = require('../../apps/javi_carlauncher/navegacion-acciones');
const { instruction } = require('../../apps/javi_carlauncher/navegacion-indicaciones');
const { world, geo, visibleTiles, project, fit, clipSegment, createMap } = require('../../native/javi-carlab/navigation-map');
const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
const { controls } = require('../../native/javi-carlab/navigation-panels');
const { Recorder } = require('../../native/javi-carlab/vendor/kit_record');
const { map } = require('../../native/javi-carlab/drivehub-state');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const address = { optionPOILocation: { coordinatesValid: true, heightValid: false, latitude: 40.4168, longitude: -3.7038, name: 'Museo de prueba', naviLocation: { opaque: 'kept' } } };
const defaults = { costModel: 'FASTEST', routePreferences: [{ type: 'FERRIES', action: 'AVOID' }], detourPreference: 'AUTOMATIC',
    eRoutePreference: { eRoutesOn: true, minSoCAtChargingStation: 10, minSoCAtFinalDestination: 10, preferBmwChargingStations: false } };
function fixture() {
    const calls = [], events = {}, proxies = {}; let time = 0, session = 10, definition;
    function event(name) { return { subscribe: async (fn) => { events[name] = fn; return name; }, unsubscribe: async () => { delete events[name]; calls.push(['unsubscribe', name]); } }; }
    Object.keys(contracts).forEach((key) => {
        const p = { dispose: async () => calls.push(['dispose', key]) };
        (contracts[key].methods || []).forEach((m) => p[m] = async (args) => { calls.push([m, args]); return { GenericError: 0 }; });
        (contracts[key].broadcasts || []).forEach((b) => p[b] = event(key + '.' + b));
        proxies[key] = p;
    });
    for (const key of ['search', 'poi']) {
        const p = proxies[key];
        p[key === 'poi' ? 'createPOISearchSession' : 'createSession'] = async () => ({ NoMoreHandlesError: 0, sessionID: ++session });
        p.createViewByIndex = async (args) => { calls.push(['createViewByIndex', args]); return { ListError: 0, view: Object.assign({ view: 1 }, args.list) }; };
    }
    proxies.search.getValidatedLocation = async () => ({ InvalidListKey: 0, address });
    proxies.poi.getPOIDetail = async () => ({ POIDetailError: 0, validatedLocation: address, detail: { telefonNumber: '900 000 000' } });
    proxies.categories.specialCategoryList = { getValue: async () => [{ type: 'CHARGING_STATION', categories: [{ categoryId: { id: '98765432123456789', sourceId: 1 } }] }] };
    proxies.routing.userCommonOptions = { getValue: async () => defaults };
    proxies.routing.routeSummary = { getValue: async () => [{ sessionID: 80, routeSummaryElementList: [{ validity: true,
        routeIdentifier: { sessionID: 80, routeHandle: 3 }, routeStatus: { routeCalculationStatus: { calculationProgress: 'ROUTE_FULLY_AVAILABLE' } } }] }] };
    proxies.routing.createRoutingSession = async (args) => { calls.push(['createRoutingSession', args]); definition = args.tripDefinition; return { CreateRoutingSessionError: 0, sessionID: 80 }; };
    proxies.routing.calculateRoute = async (args) => { calls.push(['calculateRoute', args]); return { CalculateRouteError: 0, routeIdentifier: { sessionID: 80, routeHandle: 3 } }; };
    proxies.routing.getTripDefinition = async () => ({ GenericRouteSessionError: 0, tripDefinition: definition });
    proxies.trips.currentTrips = { getValue: async () => [] };
    const builders = { buildAndInitTypedProxy: async (name) => proxies[Object.keys(contracts).find((k) => contracts[k].name === name)] };
    const engine = createActions(builders, { now: () => time, sleep: async (n) => { time += n; } });
    function results(poi, id) {
        const sessionID = id || session;
        const row = { key: 3, poiName: 'Museo de prueba', type: 'POI', poiID: { id: '123', sourceId: 1 }, distanceToPOI: { unit: 'KM', displayLength: 1.2, rawLengthMeter: 1200 } };
        events[(poi ? 'poi' : 'search') + '.resultList']({ viewUpdateInfo: { viewId: { listname: String(sessionID), view: 1 } },
            resultList: poi ? { sessionID, poiResultElement: [row] } : { resultListElements: [row] } });
    }
    return { engine, events, calls, proxies, results, advance(n) { time += n; } };
}
async function select(f) { await f.engine.command({ request: 1, action: 'search', query: 'Museo' }); f.results(); await f.engine.command({ request: 2, action: 'select', id: '11:3' }); }

test('BMW search owns its decimal session list, filters foreign results and preserves the validated location', async () => {
    const f = fixture();
    assert.equal(f.calls.length, 0);
    await f.engine.command({ request: 1, action: 'search', query: 'Museo' });
    assert.deepEqual(f.calls.find((c) => c[0] === 'createViewByIndex')[1], { list: { listname: '11' }, viewsize: 32, position: 0, policy: 'START', offset: 0 });
    f.results(false, 99); assert.equal(f.engine.snapshot().results.length, 0);
    f.results(); assert.equal(f.engine.snapshot().results[0].name, 'Museo de prueba');
    await f.engine.command({ request: 2, action: 'select', id: '11:3' });
    assert.equal(f.engine.snapshot().selected.latitude, 40.4168);
    await f.engine.command({ request: 3, action: 'route', preferences: { charging: true, arrival: 15 } });
    const segment = f.calls.find((c) => c[0] === 'createRoutingSession')[1].tripDefinition.tripSegment[0];
    assert.deepEqual(segment.destination, address); assert.equal(segment.routeOptions.eRoutePreference.minSoCAtFinalDestination, 15);
    assert.equal(f.calls.some((c) => c[0] === 'startGuidance'), false);
    await f.engine.stop(); assert.equal(f.calls.filter((c) => c[0] === 'deleteSession').length, 2);
});

test('charge search uses the vehicle category IDs and explicit view bounds, without text guessing', async () => {
    const f = fixture(); await f.engine.command({ request: 1, action: 'chargers' }); f.results(true);
    assert.equal(f.engine.snapshot().results[0].type, 'charger');
    assert.deepEqual(f.calls.find((c) => c[0] === 'setCategories')[1].categoryList, [{ id: '98765432123456789', sourceId: 1 }]);
    await f.engine.stop(); assert.equal(f.calls.some((c) => c[0] === 'deletePOISearchSession'), true);
});

test('preview waits for BMW calculation, starts only on command, and hiding preserves active guidance', async () => {
    const f = fixture(); await select(f); await f.engine.command({ request: 3, action: 'route' });
    assert.equal(f.engine.snapshot().status, 'preview');
    f.events['routing.routeInfoUpdate']({ routeInfoList: [{ routeIdentifier: { sessionID: 80, routeHandle: 3 }, routeInfos: [{ key: 'ROUTE_INFO', value: { sectionInfo: {
        length: { unit: 'KM', displayLength: 50.4, rawLengthMeter: 50400 }, duration: { timebase: 'SECONDS', duration: 2399 } } } }] }] });
    assert.equal(f.engine.snapshot().plan.metres, 50400);
    await f.engine.command({ request: 4, action: 'start' }); assert.equal(f.engine.snapshot().status, 'guiding');
    await f.engine.command({ request: 4, action: 'start' });
    assert.equal(f.calls.filter((c) => c[0] === 'startGuidance').length, 1);
    await f.engine.stop();
    assert.equal(f.calls.some((c) => c[0] === 'stopGuidance'), false);
    assert.equal(f.calls.some((c) => c[0] === 'deleteSession' && c[1].sessionID === 80), false);
});

test('explicit stop releases our started route after stopping BMW guidance', async () => {
    const f = fixture(); await select(f); await f.engine.command({ request: 3, action: 'route' });
    await f.engine.command({ request: 4, action: 'start' }); await f.engine.command({ request: 5, action: 'stop' });
    assert.equal(f.engine.snapshot().status, 'idle');
    assert.equal(f.calls.filter((c) => c[0] === 'stopGuidance').length, 1);
    assert.equal(f.calls.some((c) => c[0] === 'deleteSession' && c[1].sessionID === 80), true);
    await f.engine.stop();
});

test('failed calculations never offer start, delete only their own session and preserve defaults', async () => {
    const f = fixture(); await select(f);
    const before = JSON.stringify(defaults);
    f.proxies.routing.calculateRoute = async () => ({ CalculateRouteError: 'INVALID_TRIP' });
    await f.engine.command({ request: 3, action: 'route', preferences: { charging: false, tolls: false } });
    assert.equal(f.engine.snapshot().status, 'error'); assert.equal(f.engine.snapshot().plan, null);
    assert.equal(f.calls.some((c) => c[0] === 'deleteSession' && c[1].sessionID === 80), true);
    assert.equal(JSON.stringify(defaults), before); await f.engine.stop();
});

test('closing during session creation cleans up the late session before disposing its proxy', async () => {
    const f = fixture(); let release;
    f.proxies.search.createSession = () => new Promise((r) => { release = r; });
    const pending = f.engine.command({ request: 1, action: 'search', query: 'Tarde' }); await flush(); f.engine.stop();
    release({ NoMoreHandlesError: 0, sessionID: 900 }); await pending;
    assert.equal(f.calls.some((c) => c[0] === 'startSearch'), false);
    const deletion = f.calls.findIndex((c) => c[0] === 'deleteSession' && c[1].sessionID === 900);
    assert(deletion >= 0); assert(f.calls.findIndex((c) => c[0] === 'dispose') > deletion);
});

test('an unresponsive search expires and invalid result selections cannot reuse an old destination', async () => {
    const f = fixture(); await f.engine.command({ request: 1, action: 'search', query: 'Nada' }); f.advance(31000);
    assert.equal(f.engine.snapshot().error, 'BMW_SEARCH_TIMEOUT');
    await f.engine.command({ request: 2, action: 'select', id: '99:3' });
    assert.equal(f.engine.snapshot().error, 'RESULT_EXPIRED'); await f.engine.stop();
});

test('manual stops retain their order and original navigation payload, while preferences stay per-route', () => {
    const prefs = routeOptions(defaults, { tolls: false, arrival: 20 });
    const def = tripDefinition([{ address }, { address }], prefs);
    assert.equal(def.tripSegment[0].destinationType, 'HARD_VIAPOINT'); assert.equal(def.tripSegment[1].destinationType, 'DESTINATION');
    assert.equal(def.tripSegment[0].isERouteTripSegment, false);
    assert.deepEqual(prefs.routePreferences, [{ type: 'FERRIES', action: 'AVOID' }, { type: 'TOLLROADS', action: 'AVOID' }]);
    assert.equal(defaults.eRoutePreference.minSoCAtFinalDestination, 10);
});

test('saved destinations restore BMW binary location data without turning bytes into a plain JSON object', async () => {
    const f = fixture();
    const bookmark = { name: 'Destino guardado', address: { optionPOILocation: Object.assign({}, address.optionPOILocation,
        { naviLocation: { vendorID: 1, containerVersion: 1, presentationArea: [], internalData: Buffer.from([0, 127, 255]) } }) } };
    await f.engine.command(JSON.parse(JSON.stringify({ request: 1, action: 'restore', bookmark })));
    await f.engine.command({ request: 2, action: 'route' });
    const used = f.calls.find((c) => c[0] === 'createRoutingSession')[1].tripDefinition.tripSegment[0].destination.optionPOILocation;
    assert(Buffer.isBuffer(used.naviLocation.internalData)); assert.deepEqual(Array.from(used.naviLocation.internalData), [0, 127, 255]);
    await f.engine.stop();
});

test('guidance uses BMW maneuver and distance, never infers a turn from a polyline', () => {
    assert.deepEqual(instruction({ maneuver: { roundabout: { exitNumber: 3, formattedDistance: { rawDistance: 180 }, description: { elements: [{ text: 'A-3' }] } } } }),
        { kind: 'roundabout', direction: 'NONE', metres: 180, road: 'A-3', exit: 3 });
    assert.equal(instruction({ maneuver: { intersection: { unreliable: true } } }), null);
});

test('Mercator viewport, dateline fitting and segment clipping stay bounded at street zoom', () => {
    const center = { latitude: 40.4, longitude: -3.7, zoom: 16 }, xy = world(center, 16), back = geo(xy[0], xy[1], 16);
    assert(Math.abs(back.latitude - center.latitude) < 1e-8); assert(Math.abs(back.longitude - center.longitude) < 1e-8);
    assert.deepEqual(project(center, center), [map.x + map.w / 2, map.y + map.h / 2]);
    assert(visibleTiles(center).length <= 18);
    assert(fit([{ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }]).zoom > 8);
    const clipped = clipSegment([-100000, 20], [100000, 20], { x: 0, y: 0, w: 100, h: 50 });
    assert(Math.abs(clipped[0][0]) < 1e-8 && Math.abs(clipped[1][0] - 100) < 1e-8);
    assert.equal(clipped[0][1], 20); assert.equal(clipped[1][1], 20);
    assert.equal(clipSegment([-10, -10], [-5, -5], { x: 0, y: 0, w: 100, h: 50 }), null);
});

test('map UI searches only on submit, keeps gestures inside its panel and cancels on coverage', () => {
    const sent = [], ui = createNavigationUI({ navigationCommand: (c) => { sent.push(c); return true; } }, () => {});
    const nav = { state: 'inactive', points: [], destinations: [], segments: [], theme: 'day' };
    ui.update(nav, {}, true); ui.activate('search'); ui.activate('key:M'); ui.activate('key:Á');
    assert.equal(sent.length, 0); ui.activate('submit'); assert.equal(sent[0].query, 'MÁ');
    const cv = new Recorder(1960, 520); controls(cv, ui, nav);
    assert(ui.state.buttons.every((b) => b.x >= map.x && b.y >= map.y && b.x + b.w <= map.x + map.w && b.y + b.h <= map.y + map.h));
    const b = ui.state.buttons.find((b) => b.id === 'close');
    ui.touch('down', b.x + 2, b.y + 2); ui.reset(); ui.touch('up', b.x + 2, b.y + 2);
    assert.equal(ui.state.panel, 'search'); ui.close();
});

test('navigation wheel selects controls only with map focus and a covered press never clicks on return', () => {
    const ui = createNavigationUI({}, () => {}), cv = new Recorder(1960, 520);
    const nav = { state: 'inactive', points: [], destinations: [], segments: [], theme: 'day' };
    ui.update(nav, {}, true); controls(cv, ui, nav);
    assert.equal(ui.controller({ knob: 0, press: 0, tilt: 0 }), false);
    ui.state.focused = true; ui.controller({ knob: 0, press: 0, tilt: 0 }); ui.controller({ knob: 1, press: 0, tilt: 0 });
    assert.notEqual(ui.state.focus, -1);
    ui.state.focus = 'search'; ui.controller({ knob: 1, press: 1, tilt: 0 }); ui.reset();
    ui.controller({ knob: 1, press: 0, tilt: 0 }); assert.equal(ui.state.panel, 'none');
    ui.controller({ knob: 1, press: 1, tilt: 0 }); ui.controller({ knob: 1, press: 0, tilt: 0 }); assert.equal(ui.state.panel, 'search'); ui.close();
});

test('map loads only the visible viewport, reuses its persistent cache and stops requests while hidden', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-map-test-'));
    const Canvas = require('../../native/javi-carlab/vendor/kit_canvas').Canvas;
    const png = new Canvas(256, 256).png(1), camera = { latitude: 0, longitude: 0, zoom: 8 };
    let requests = 0;
    const options = { mapDirectory: root, get: async () => { requests++; return png; } };
    let first, second;
    async function settled(mapper) {
        const deadline = Date.now() + 10000;
        while (mapper.status().loading && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
        assert.equal(mapper.status().loading, false); assert.equal(mapper.status().ready, true);
    }
    try {
        first = createMap(options, () => {}); first.update(camera, false); await flush(); assert.equal(requests, 0);
        first.update(camera, true); await settled(first);
        assert.equal(requests, visibleTiles(camera).length);
        first.close(); const count = requests;
        second = createMap(options, () => {}); second.update(camera, true); await settled(second); assert.equal(requests, count);
        second.update(Object.assign({}, camera, { longitude: 40 }), false); await flush(); assert.equal(requests, count);
    } finally { if (first) first.close(); if (second) second.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('all navigation modules are shipped with the OAP and native component', () => {
    const app = require('../../apps/javi_carlauncher/mgu-app.json');
    for (const file of app.modules) {
        const code = fs.readFileSync(path.join(__dirname, '../../apps/javi_carlauncher', file), 'utf8');
        const imports = code.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g);
        for (const match of imports) assert(app.modules.includes(match[1]), file + ' requires an exact module filename including .js: ' + match[1]);
    }
    const native = require('../../native/javi-carlab/component.json');
    ['navigation-model.js', 'navigation-view.js', 'navigation-map.js', 'navigation-ui.js', 'navigation-panels.js'].forEach((file) => assert(native.files.some((f) => f.path === file)));
});
