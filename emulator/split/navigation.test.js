'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProbe, services, tripSummary, polyline } = require('../../apps/javi_carlauncher/navegacion-bmw');
const { consume, createNavigation, decodePolyline, routeGeometry, validate } = require('../../native/javi-carlab/navigation-model');
const { drawNavigation, projection, actionAt, toggle, controls } = require('../../native/javi-carlab/navigation-view');
const { Recorder } = require('../../native/javi-carlab/vendor/kit_record');
const { EventEmitter } = require('node:events');
const createSession = require('../../native/javi-carlab/drivehub-session');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';
const end = { latitude: 43.252, longitude: -126.453 };
function frame() {
    return { version: 1, at: 1000, state: 'active', routeStatus: 'ready', theme: 'day', electricRouting: true,
        route: { key: '1:2', at: 1000, encoded }, destinationsKnown: true,
        destinations: [{ position: Object.assign({}, end), charging: false, final: true, metres: 12345, seconds: 1234 }],
        segments: [{ name: 'Estación de carga', charging: false, preferences: { enabled: true, arrivalMinimum: 10 } }] };
}
test('BMW E5 polyline matches the public oracle, verifies its endpoint and bounds malformed geometry', () => {
    assert.deepEqual(decodePolyline(encoded), [{ latitude: 38.5, longitude: -120.2 }, { latitude: 40.7, longitude: -120.95 }, end]);
    assert.equal(routeGeometry(encoded, end).length, 3);
    assert.throws(() => routeGeometry(encoded, { latitude: 40, longitude: -3 }), /mismatch/);
    assert.throws(() => routeGeometry(encoded, null), /missing/);
    for (const s of ['_', '??_', '\u00e9?', '~~~~~~~?', '?'.repeat(65537), '']) assert.throws(() => decodePolyline(s));
    assert.equal(polyline([-193, 63]), null);
    assert.equal(polyline(Buffer.from(encoded)), encoded);
});
test('navigation transport preserves split UTF-8 and rejects invalid or oversized messages', () => {
    const rows = [], read = consume((f) => rows.push(f));
    const bytes = Buffer.from(JSON.stringify(frame()) + '\n');
    for (const byte of bytes) assert.equal(read(Buffer.from([byte])), true);
    assert.equal(rows[0].segments[0].name, 'Estación de carga');
    assert.equal(consume(() => {})(Buffer.alloc(128 * 1024 + 1, 65)), false);
    for (const mutate of [(f) => { f.state = 'unknown'; }, (f) => { f.destinations[0].position.latitude = 91; },
        (f) => { f.route.encoded = '<'; }, (f) => { f.segments[0].preferences.arrivalMinimum = -1; }]) {
        const f = frame(); mutate(f); assert.equal(validate(f), false);
    }
});
test('navigation removes stale data and never presents endpoint-mismatched or inactive geometry', () => {
    const model = createNavigation();
    model.receive(frame(), 1000);
    assert.equal(model.snapshot(1001).points.length, 3);
    assert.equal(model.snapshot(7000).state, 'unavailable');
    const changed = frame(); changed.destinations[0].position = { latitude: 40, longitude: -3 };
    model.receive(changed, 2000);
    assert.equal(model.snapshot(2000).points.length, 0);
    assert.equal(model.snapshot(2000).geometryError, 'route-endpoint-mismatch');
    model.receive(Object.assign(frame(), { state: 'inactive', route: null, destinations: [], segments: [] }), 2000);
    assert.equal(model.snapshot(2000).points.length, 0);
    model.receive(null, 3000); assert.equal(model.snapshot(3000).state, 'unavailable');
});
function rig(state) {
    const callbacks = {}, timers = [], calls = [], disposed = [], removed = [];
    const values = { guidanceState: state, currentRoute: { sessionID: 1, routeHandle: 2 },
        allDestinationsInfo: [{ position: Object.assign({ coordinatesValid: true }, end), isCheckeredFlag: true,
            isChargingStation: false, travelTime: 1234, formattedDistance: { rawDistance: 12345 } }],
        currentTrips: [], eRoutesOn: true, dayNightMode: 'DAY' };
    const proxies = {};
    Object.keys(services).forEach((key) => {
        const spec = services[key], p = { dispose() { disposed.push(key); } };
        (spec.attributes || []).forEach((name) => { p[name] = {
            async getValue() { return values[name]; },
            async subscribe(fn) { callbacks[name] = fn; return name; },
            async unsubscribe(id) { removed.push(id); }
        }; });
        if (key === 'routing') {
            p.routeExported = { async subscribe(fn) { callbacks.exported = fn; return 42; }, async unsubscribe(id) { removed.push(id); } };
            p.exportActiveRoute = async (args) => { calls.push(args); return { ExportRouteError: 'NO_ERROR' }; };
        }
        proxies[spec.name] = p;
    });
    let time = 1000;
    const probe = createProbe({ async buildAndInitTypedProxy(name, instance) { assert.equal(instance, name === services.light.name ? '1' : 'Main_Instance'); return proxies[name]; } },
        { now: () => time, every(fn, ms) { const t = { fn, ms }; timers.push(t); return t; }, cancel(t) { t.cancelled = true; } });
    return { probe, callbacks, timers, calls, disposed, removed, values, proxies,
        advance(n) { time += n; }, async tick(ms) { timers.filter((t) => !t.cancelled && t.ms === ms).forEach((t) => t.fn()); await flush(); } };
}
test('BMW adapter exports only the active route, filters other sessions and releases every subscription', async () => {
    const r = rig('INACTIVE'); await flush(); await r.tick(1000); assert.equal(r.calls.length, 0);
    r.callbacks.guidanceState('ACTIVE'); await r.tick(5000); // refresh also re-reads the state
    r.values.guidanceState = 'ACTIVE'; await r.tick(5000); await r.tick(1000);
    assert.deepEqual(r.calls, [{ referencingMethod: 'POLYLINE' }]);
    const event = { exportSuccess: true, referencingMethod: 'POLYLINE', routeIdentifier: { sessionID: 7, routeHandle: 2 }, encodedRoute: Buffer.from(encoded) };
    r.callbacks.exported(event); assert.equal(r.probe.snapshot().route, null);
    event.routeIdentifier.sessionID = 1; r.callbacks.exported(event);
    assert.equal(r.probe.snapshot().route.encoded, encoded);
    assert.equal(validate(r.probe.snapshot()), true);
    r.callbacks.currentRoute({ sessionID: 1, routeHandle: 3 }); assert.equal(r.probe.snapshot().route, null);
    assert.deepEqual(r.probe.snapshot().destinations, []);
    r.callbacks.exported(event); assert.equal(r.probe.snapshot().route, null);
    r.probe.stop(); await flush();
    assert.equal(r.disposed.length, 5); assert.equal(r.removed.length, 10);
    assert.equal(r.timers.every((t) => t.cancelled), true);
    await r.tick(1000); assert.equal(r.calls.length, 1);
});
test('a late proxy is disposed and unresponsive fields expire without invented route data', async () => {
    let release; const pending = new Promise((resolve) => { release = resolve; }); let disposed = 0;
    const p = createProbe({ buildAndInitTypedProxy: () => pending }, { every: () => 1, cancel() {} });
    p.stop(); release({ dispose() { disposed++; } }); await flush(); assert.equal(disposed, 5);
    const r = rig('ACTIVE'); await flush(); r.advance(16000);
    assert.equal(r.probe.snapshot().state, 'unavailable'); assert.equal(r.probe.snapshot().route, null);
    r.probe.stop();
});

test('navigation retries unavailable services after startup, without duplicate proxies or retries after closing', async () => {
    const attempts = {}, timers = [], disposed = [];
    let time = 1000;
    const probe = createProbe({ async buildAndInitTypedProxy(name) {
        attempts[name] = (attempts[name] || 0) + 1;
        if (attempts[name] === 1) throw new Error('SERVICE_NOT_AVAILABLE');
        const spec = Object.keys(services).map((k) => services[k]).find((s) => s.name === name);
        const p = { dispose() { disposed.push(name); } };
        (spec.attributes || []).forEach((a) => { p[a] = { async subscribe() { return 1; }, async unsubscribe() {}, async getValue() { return a === 'guidanceState' ? 'INACTIVE' : undefined; } }; });
        p.routeExported = { async subscribe() { return 1; }, async unsubscribe() {} };
        return p;
    } }, { now: () => time, every(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel(t) { t.cancelled = true; } });
    await flush(); assert.equal(probe.snapshot().state, 'unavailable');
    time += 5000; timers.filter((t) => t.ms === 5000).forEach((t) => t.fn()); await flush();
    assert.equal(probe.snapshot().state, 'inactive');
    time += 5000; timers.filter((t) => t.ms === 5000).forEach((t) => t.fn()); await flush();
    assert(Object.values(attempts).every((count) => count === 2));
    probe.stop(); await flush();
    timers.forEach((t) => t.fn()); await flush();
    assert(Object.values(attempts).every((count) => count === 2)); assert.equal(disposed.length, 5);
    assert(timers.every((t) => t.cancelled));
});
test('electrical route preferences are read from the matching BMW route without guessing stop charge values', () => {
    const route = { sessionID: 1, routeHandle: 2 };
    const trips = [{ active: true, routeIdentifer: route, tripDefinition: { tripSegment: [
        { destinationType: 'DESTINATION', isERouteTripSegment: false, destination: { optionPOILocation: { name: 'Área de recarga' } },
            routeOptions: { eRoutePreference: { eRoutesOn: true, minSoCAtFinalDestination: 10 } } }
    ] } }];
    assert.deepEqual(tripSummary(trips, route)[0].preferences, { enabled: true, arrivalMinimum: 10 });
    assert.deepEqual(tripSummary(trips, { sessionID: 2, routeHandle: 2 }), []);
    assert.equal(tripSummary(trips, route)[0].name, 'Área de recarga');
});

test('automatic map theme uses the vehicle day/night signal and expires invalid values', async () => {
    const r = rig('INACTIVE'); await flush();
    r.callbacks.dayNightMode('AUTO'); r.callbacks.statusDayNightChangeOver({ dayNightChangeOver: 'TAG' });
    assert.equal(r.probe.snapshot().theme, 'day');
    r.callbacks.statusDayNightChangeOver({ dayNightChangeOver: 'KEINE_AENDERUNG' }); assert.equal(r.probe.snapshot().theme, 'day');
    r.callbacks.statusDayNightChangeOver({ dayNightChangeOver: 'NACHT' }); assert.equal(r.probe.snapshot().theme, 'night');
    r.callbacks.statusDayNightChangeOver({ dayNightChangeOver: 'SIGNAL_UNGUELTIG' }); assert.equal(r.probe.snapshot().theme, 'auto');
    r.probe.stop();
});
test('the route view contains no invented roads, identifies missing cartography and keeps controls inside the left panel', () => {
    const model = createNavigation(); model.receive(frame(), 1000);
    const cv = new Recorder(1960, 520), labels = [];
    const original = cv.text; cv.text = function(s) { labels.push(s); return original.apply(this, arguments); };
    drawNavigation(cv, model.snapshot(1000), {}, 1, 1000);
    assert.ok(labels.includes('Vista de ruta · cartografía pendiente'));
    assert.ok(labels.includes('Mínimo al destino: 10%'));
    assert.equal(actionAt(toggle.x + 10, toggle.y + 10, false, model.snapshot(1000)), 'toggle');
    assert.equal(actionAt(controls[0].x + 10, controls[0].y + 10, true, model.snapshot(1000)), null);
    assert.equal(actionAt(1100, 300, false, model.snapshot(1000)), null);
    const dateline = projection([{ latitude: 0, longitude: 179.9 }, { latitude: 0, longitude: -179.9 }], 1);
    assert.ok(dateline.points.every((p) => p.every(Number.isFinite)));
});
test('map controls use completed taps, preserve DriveHub input and cancel a gesture when covered', async () => {
    class GPU extends EventEmitter {
        constructor() { super(); this.frames = []; }
        frame(cv) { this.frames.push(Array.from(cv.words())); }
        show() {} place() {} claim() {} grab() {} close() {}
    }
    const gpu = new GPU();
    const session = createSession(gpu, { fixture: {}, diagnostics: false, area: () => ({ x: 0, y: 0, w: 1960, h: 520, scale: 1 }) });
    try {
        session.show(true); gpu.emit('ready', {}, { touch: true });
        const initial = gpu.frames[0];
        const x = toggle.x + 5, y = toggle.y + 5;
        gpu.emit('touch', 'down', x, y); gpu.emit('state', { onScreen: false });
        gpu.emit('state', { onScreen: true }); gpu.emit('touch', 'up', x, y);
        await new Promise((resolve) => setTimeout(resolve, 45));
        assert.deepEqual(gpu.frames[gpu.frames.length - 1], initial);
        // A second full tap remains usable after the cancelled gesture.
        gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y);
        await new Promise((resolve) => setTimeout(resolve, 45));
        assert.ok(gpu.frames.length > 1);
        assert.notDeepEqual(gpu.frames[gpu.frames.length - 1], initial);
        session.telemetry([{ signal: 'rawPositionData', status: 'sample', sampledAt: Date.now(), freshForMs: 5000,
            fields: { 'position.coordinatesValid': true, 'position.latitude': 40.4168, 'position.longitude': -3.7038 } }]);
        gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y);
        await new Promise((resolve) => setTimeout(resolve, 45));
        assert.ok(gpu.frames.length > 2);
    } finally { session.close(); }
});
