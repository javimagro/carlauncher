'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createActions, contracts, tripDefinition, routeOptions } = require('../../apps/javi_carlauncher/navegacion-acciones');
const { instruction } = require('../../apps/javi_carlauncher/navegacion-indicaciones');
const { world, geo, project, fit, clipSegment, createMap } = require('../../native/javi-carlab/navigation-map');
const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
const { controls, searchMessage } = require('../../native/javi-carlab/navigation-panels');
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

test('visible BMW search results gain validated coordinates without serializing private addresses into every row', async () => {
    const f = fixture(); let pendingDetail, calls = 0;
    f.proxies.poi.getPOIDetail = () => { calls++; return new Promise((resolve) => { pendingDetail = resolve; }); };
    await f.engine.command({ request: 1, action: 'chargers' }); f.results(true); f.results(true);
    assert.equal(calls, 1);
    assert.equal(f.engine.snapshot().results[0].positionState, 'pending');
    const selection = f.engine.command({ request: 2, action: 'select', id: '11:3' });
    assert.equal(calls, 1, 'selection shares an in-flight lookup');
    pendingDetail({ POIDetailError: 0, validatedLocation: address, detail: {} });
    await selection; await flush();
    const row = f.engine.snapshot().results[0];
    assert.equal(row.latitude, address.optionPOILocation.latitude); assert.equal(row.positionState, 'ready');
    assert.equal(row.address, undefined); assert.equal(f.engine.snapshot().status, 'detail');
    assert.equal(f.engine.snapshot().selected.type, 'charger');
    assert.deepEqual(f.engine.snapshot().selected.address, address);
    await f.engine.stop();
});

test('background result lookup is bounded, ignores an old session and stops scheduling after close', async () => {
    const f = fixture(); const pending = []; let calls = 0;
    f.proxies.poi.getPOIDetail = () => { calls++; return new Promise((resolve) => pending.push(resolve)); };
    await f.engine.command({ request: 1, action: 'chargers' });
    const event = { viewUpdateInfo: { viewId: { listname: '11', view: 1 } }, resultList: { sessionID: 11,
        poiResultElement: Array.from({ length: 100 }, (_, i) => ({ key: i, poiName: 'Lugar', poiID: { id: String(i), sourceId: 1 } })) } };
    f.events['poi.resultList'](event); assert.equal(calls, 1); assert.equal(f.engine.snapshot().results.length, 32);
    await f.engine.command({ request: 2, action: 'search', query: 'Otra búsqueda' });
    pending.shift()({ POIDetailError: 0, validatedLocation: address }); await flush();
    assert.deepEqual(f.engine.snapshot().results, []); assert.equal(calls, 1);
    await f.engine.command({ request: 3, action: 'chargers' });
    event.viewUpdateInfo.viewId.listname = '13'; event.resultList.sessionID = 13;
    f.events['poi.resultList'](event); assert.equal(calls, 2);
    await f.engine.stop(); pending.shift()({ POIDetailError: 0, validatedLocation: address }); await flush();
    assert.equal(calls, 2);
});

test('a missing BMW coordinate is not replaced by the vehicle position and does not discard the result', async () => {
    const f = fixture(); f.proxies.poi.getPOIDetail = async () => ({ POIDetailError: 0, validatedLocation: { optionPOILocation: { coordinatesValid: false } } });
    await f.engine.command({ request: 1, action: 'chargers' }); f.results(true); await flush();
    const row = f.engine.snapshot().results[0]; assert.equal(row.positionState, 'unavailable'); assert.equal(row.latitude, undefined);
    assert.equal(row.name, 'Museo de prueba'); assert.equal(f.engine.snapshot().status, 'results');
    await f.engine.stop();
});

test('BMW POI completion uses SearchState.searchStatus, while FTS publishes the enum directly', async () => {
    const f = fixture();
    await f.engine.command({ request: 1, action: 'chargers' });
    f.events['poi.searchStatus']({ sessionID: 99, searchState: { searchStatus: 3 } });
    assert.equal(f.engine.snapshot().status, 'loading');
    f.events['poi.searchStatus']({ sessionID: 11, searchState: { searchStatus: 3,
        onlineSearchState: { onlineSearchStatus: 1, errorReason: 0 } } });
    assert.equal(f.engine.snapshot().status, 'results');
    f.advance(31000); assert.equal(f.engine.snapshot().error, '');
    assert.deepEqual(f.engine.snapshot().results, []);
    await f.engine.command({ request: 2, action: 'search', query: 'Calle Mayor' });
    f.events['search.searchStatus']({ sessionID: 12, searchState: 'FINISHED' });
    assert.equal(f.engine.snapshot().status, 'results');
    await f.engine.stop();
});

test('an initial empty BMW view stays loading until completion, and early results survive view creation', async () => {
    const f = fixture();
    f.proxies.poi.createViewByIndex = async (args) => {
        f.events['poi.resultList']({ viewUpdateInfo: { viewId: { listname: '11', view: 1 }, operation: 'DATA_CHANGED', positionInList: 0, positionInView: 0 },
            resultList: { sessionID: 11, poiResultElement: [] } });
        assert.equal(f.engine.snapshot().status, 'loading');
        f.results(true);
        return { ListError: 0, view: Object.assign({ view: 1 }, args.list) };
    };
    await f.engine.command({ request: 1, action: 'chargers' });
    assert.equal(f.engine.snapshot().results.length, 1);
    assert.equal(f.engine.snapshot().status, 'results');
    await f.engine.stop();
});

test('BMW list size distinguishes lost results from no matches and a destroyed view cannot revive', async () => {
    const f = fixture(); await f.engine.command({ request: 1, action: 'chargers' });
    function changed(operation, size, view) {
        f.events['poi.changedViewInfo']({ operation, list_update: { list: { listname: '11' }, size, views: 1 },
            view_update: { view: { listname: '11', view: view || 1 }, size } });
    }
    changed('DATA_CHANGED', 4);
    f.events['poi.searchStatus']({ sessionID: 11, searchState: { searchStatus: 'FINISHED' } });
    assert.equal(f.engine.snapshot().status, 'loading');
    f.advance(6000);
    f.events['poi.searchStatus']({ sessionID: 11, searchState: { searchStatus: 'FINISHED' } });
    assert.equal(f.engine.snapshot().error, 'BMW_LIST_NOT_RECEIVED');
    f.results(true); assert.equal(f.engine.snapshot().status, 'results'); assert.equal(f.engine.snapshot().error, '');
    changed('DESTROYED', 0, 2); assert.equal(f.engine.snapshot().status, 'results');
    changed('DESTROYED', 0); assert.equal(f.engine.snapshot().error, 'BMW_LIST_DESTROYED');
    changed('DATA_CHANGED', 4);
    f.results(true); f.events['poi.searchStatus']({ sessionID: 11, searchState: { searchStatus: 3 } });
    assert.equal(f.engine.snapshot().status, 'error'); assert.deepEqual(f.engine.snapshot().results, []);
    await f.engine.stop();
});

test('late BMW list and status events cannot replace the selected destination or route preview', async () => {
    const f = fixture(); await select(f);
    f.events['search.searchStatus']({ sessionID: 11, searchState: 3 }); f.results();
    assert.equal(f.engine.snapshot().status, 'detail');
    await f.engine.command({ request: 3, action: 'route' });
    f.events['search.searchStatus']({ sessionID: 11, searchState: 3 }); f.results();
    assert.equal(f.engine.snapshot().status, 'preview');
    await f.engine.stop();
});

test('failed recalculation clears a previous preview instead of exposing a deleted route', async () => {
    const f = fixture(); await select(f); await f.engine.command({ request: 3, action: 'route' });
    assert(f.engine.snapshot().plan);
    f.proxies.routing.calculateRoute = async () => ({ CalculateRouteError: 'INVALID_TRIP' });
    await f.engine.command({ request: 4, action: 'recalculate' });
    assert.equal(f.engine.snapshot().status, 'error'); assert.equal(f.engine.snapshot().plan, null);
    await f.engine.stop();
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

test('reopening a computed itinerary retains automatic charging stops and their coordinates', async () => {
    const f = fixture(); await select(f);
    f.proxies.routing.getTripDefinition = async () => ({ GenericRouteSessionError: 0, tripDefinition: { tripSegment: [
        { destination: address, isERouteTripSegment: true }, { destination: address, isERouteTripSegment: false }
    ] } });
    await f.engine.command({ request: 3, action: 'route' });
    assert.equal(f.engine.snapshot().stops[0].charging, true);
    await f.engine.command({ request: 4, action: 'itinerary' });
    assert.equal(f.engine.snapshot().stops.length, 2); assert.equal(f.engine.snapshot().stops[0].charging, true);
    assert.equal(f.engine.snapshot().stops[0].latitude, address.optionPOILocation.latitude);
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

test('charger panel reports waiting, failure and empty results separately and retries the POI search', () => {
    const sent = [], ui = createNavigationUI({ navigationCommand: (c) => { sent.push(c); return true; } }, () => {});
    const nav = { state: 'inactive', points: [], destinations: [], segments: [], theme: 'day' };
    ui.update(nav, {}, true); ui.activate('chargers');
    assert.equal(ui.state.pending, true);
    const idle = { request: 0, status: 'idle', busy: false, results: [], stops: [], selected: null, plan: null, error: '' };
    ui.update(Object.assign({}, nav, { controls: idle }), {}, true);
    assert.equal(ui.state.panel, 'search'); assert.equal(ui.state.controls, null);
    const failure = Object.assign({}, idle, { request: sent[0].request, status: 'error', error: 'BMW_SEARCH_TIMEOUT', searchPhase: 'results' });
    ui.update(Object.assign({}, nav, { controls: failure }), {}, true);
    assert.equal(ui.state.pending, false);
    controls(new Recorder(1960, 520), ui, nav);
    const retry = ui.state.buttons.find((b) => b.id === 'chargers' && b.w > 70);
    assert(retry && !retry.disabled);
    ui.activate(retry.id); assert.equal(sent[1].action, 'chargers');
    assert.match(searchMessage(failure, false), /no ha enviado resultados/);
    assert.match(searchMessage({ status: 'results' }, false), /terminado sin encontrar/);
    assert.match(searchMessage({ status: 'loading', searchPhase: 'categories' }, false), /categorías/);
    ui.close();
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

test('BMW local map never requests tiles or reads an external cache, including legacy options', async () => {
    let requests = 0;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-map-isolation-'));
    const file = path.join(root, 'legacy.png'); fs.writeFileSync(file, 'external cache sentinel');
    const mapper = createMap({ mapDirectory: root, mapTemplate: 'https://example.invalid/{z}/{x}/{y}.png',
        get: () => { requests++; throw new Error('External maps forbidden'); } }, () => {});
    try {
        mapper.update({ latitude: 40, longitude: -3, zoom: 16 }, true);
        mapper.draw(new Recorder(1960, 520), false);
        mapper.update({ latitude: 55, longitude: 10, zoom: 12 }, true);
        mapper.draw(new Recorder(1960, 520), true);
        await flush();
        assert.equal(requests, 0);
        assert.equal(mapper.status().ready, false);
        assert.equal(mapper.status().source, 'bmw-local');
        assert.equal(mapper.status().code, 'BMW_MAP_INSTANCE_UNAVAILABLE');
        assert.equal(mapper.status().mapVersion, null);
        assert.deepEqual(fs.readdirSync(root), ['legacy.png']);
        assert.equal(fs.readFileSync(file, 'utf8'), 'external cache sentinel');
        mapper.update(null, false); mapper.close();
        assert.equal(mapper.status().ready, false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('all navigation modules are shipped with the OAP and native component', () => {
    const app = require('../../apps/javi_carlauncher/mgu-app.json');
    for (const file of app.modules) {
        const code = fs.readFileSync(path.join(__dirname, '../../apps/javi_carlauncher', file), 'utf8');
        const imports = code.matchAll(/require\(['"]\.\/([^'"]+)['"]\)/g);
        for (const match of imports) assert(app.modules.includes(match[1]), file + ' requires an exact module filename including .js: ' + match[1]);
    }
    const native = require('../../native/javi-carlab/component.json');
    ['navigation-model.js', 'navigation-view.js', 'navigation-map.js', 'navigation-ui.js', 'navigation-panels.js',
        'navigation-layout.js', 'navigation-scene.js', 'navigation-icons.js', 'navigation-icons.rgba.gz', 'navigation-icons.SOURCES.json'].forEach((file) => assert(native.files.some((f) => f.path === file)));
});
