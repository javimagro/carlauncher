'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
const { controls } = require('../../native/javi-carlab/navigation-panels');
const layout = require('../../native/javi-carlab/navigation-layout');
const scene = require('../../native/javi-carlab/navigation-scene');
const { project, fit } = require('../../native/javi-carlab/navigation-map');
const { map, home, contains } = require('../../native/javi-carlab/drivehub-state');
const { Recorder } = require('../../native/javi-carlab/vendor/kit_record');
const origin = { latitude: 40.4, longitude: -3.7 };
const results = Array.from({ length: 9 }, (_, i) => ({ id: '11:' + i, name: 'Cargador ' + i, metres: 1000 * i,
    type: 'charger', latitude: 40.41 + .01 * i, longitude: -3.71 + .01 * i }));
function rig() {
    const sent = [], ui = createNavigationUI({ navigationCommand(c) { sent.push(c); return true; } }, () => {});
    const nav = { state: 'inactive', points: [], destinations: [], segments: [], theme: 'day' };
    function receive(extra) {
        nav.controls = Object.assign({ request: sent.length ? sent[sent.length - 1].request : 0, busy: false, status: 'results',
            query: '', error: '', results, selected: null, stops: [], plan: null }, extra);
        ui.update(nav, { location: origin }, true);
    }
    function draw() { controls(new Recorder(1960, 520), ui, nav); }
    function tap(id) {
        draw(); const b = ui.state.buttons.find((a) => a.id === id && !a.disabled); assert(b, 'No enabled ' + id);
        ui.touch('down', b.x + b.w / 2, b.y + b.h / 2); ui.touch('up', b.x + b.w / 2, b.y + b.h / 2);
    }
    ui.update(nav, { location: origin }, true);
    return { ui, sent, nav, receive, draw, tap };
}
function insideFrame(s, points) {
    const b = layout.viewport(s);
    for (const p of points) {
        const xy = project(p, s.camera);
        assert(xy[0] >= b.x + 22 && xy[0] <= b.x + b.w - 22, 'horizontal padding');
        assert(xy[1] >= b.y + 22 && xy[1] <= b.y + b.h - 22, 'vertical padding');
    }
}
test('charger list frames only its visible numbered rows beside the panel, including after scrolling', () => {
    const r = rig(); r.ui.activate('chargers'); r.receive(); r.draw();
    assert.equal(scene.markers(r.ui.state).length, 2);
    assert.deepEqual(scene.markers(r.ui.state).map((m) => m.label), ['1', '2']);
    insideFrame(r.ui.state, results.slice(0, 2));
    assert(layout.viewport(r.ui.state).x > layout.panel(r.ui.state).x + layout.panel(r.ui.state).w);
    const before = r.ui.state.camera;
    r.tap('page-down'); r.draw();
    assert.equal(r.ui.state.offset, 2); assert.notEqual(before, r.ui.state.camera);
    assert.deepEqual(scene.markers(r.ui.state).map((m) => m.label), ['3', '4']);
    insideFrame(r.ui.state, results.slice(2, 4));
    for (let n = 0; n < 15; n++) r.ui.activate('page-down');
    assert.equal(r.ui.state.offset, results.length - 2); r.ui.close();
});
test('a marker and its list row select the same BMW result; Back restores scroll and row focus', () => {
    const r = rig(); r.ui.activate('chargers'); r.receive(); r.ui.activate('page-down'); r.draw();
    // Availability is overridden only by this test. The installed provider stays unavailable.
    r.ui.tiles.status = () => ({ ready: true });
    const marker = scene.hits(r.ui.state)[1]; assert(marker);
    r.ui.touch('down', marker.x + 22, marker.y + 22); r.ui.touch('up', marker.x + 22, marker.y + 22);
    assert.equal(r.sent[1].action, 'select'); assert.equal(r.sent[1].id, results[3].id);
    r.receive({ status: 'detail', selected: Object.assign({ phone: '', details: [] }, results[3]) });
    assert.equal(r.ui.state.panel, 'detail'); r.tap('back');
    assert.equal(r.ui.state.panel, 'search'); assert.equal(r.ui.state.offset, 2);
    assert.equal(r.ui.state.searchKind, 'chargers'); assert.equal(r.ui.state.focus, 'result:11:3');
    insideFrame(r.ui.state, results.slice(2, 4)); r.ui.close();
});
test('closing during a destination lookup keeps late detail and repeated snapshots closed', () => {
    const r = rig(); r.ui.activate('chargers'); r.receive(); r.tap('result:11:0'); r.tap('close');
    r.receive({ status: 'detail', selected: Object.assign({ phone: '' }, results[0]) });
    assert.equal(r.ui.state.panel, 'none');
    r.ui.update(r.nav, { location: origin }, true); assert.equal(r.ui.state.panel, 'none');
    r.ui.close();
});
test('wheel traverses offscreen results, scrolls into view and never starts guidance by browsing', () => {
    const r = rig(); r.ui.activate('chargers'); r.receive(); r.draw(); r.ui.focus();
    r.ui.controller({ knob: 0, press: 0, tilt: 0 });
    for (let i = 1; i <= 7; i++) { r.ui.controller({ knob: i, press: 0, tilt: 0 }); r.draw(); }
    assert.equal(r.ui.state.focus, 'result:11:6'); assert.equal(r.ui.state.offset, 5);
    assert.equal(r.sent.length, 1);
    r.ui.controller({ knob: 7, press: 1, tilt: 0 }); r.ui.controller({ knob: 7, press: 0, tilt: 0 });
    assert.equal(r.sent[1].action, 'select'); assert.equal(r.sent[1].id, '11:6'); r.ui.close();
});
test('touch scroll cannot activate the crossed row and a map drag cannot scroll the list', () => {
    const r = rig(); r.ui.activate('chargers'); r.receive(); r.draw(); const b = layout.listBounds(r.ui.state);
    r.ui.touch('down', b.x + 20, b.y + 220); r.ui.touch('move', b.x + 20, b.y + 70); r.ui.touch('up', b.x + 20, b.y + 70);
    assert.equal(r.ui.state.offset, 2); assert.equal(r.sent.length, 1);
    const v = layout.viewport(r.ui.state);
    r.ui.touch('down', v.x + 60, v.y + 150); r.ui.touch('up', v.x + 60, v.y + 50);
    assert.equal(r.ui.state.offset, 2); r.ui.close();
});
test('route overview fits its bends, origin, stops and destination without borrowing a different active route', () => {
    const r = rig(); const stops = [results[3], results[6]];
    r.ui.activate('route-panel'); r.receive({ status: 'preview', stops, plan: { key: '80:3', arrival: 15, charging: true } });
    r.nav.route = { key: '12:8' }; r.nav.points = [{ latitude: 20, longitude: 30 }, { latitude: 30, longitude: 40 }];
    r.ui.update(r.nav, { location: origin }, true); assert.deepEqual(scene.routePoints(r.ui.state), []);
    insideFrame(r.ui.state, [origin].concat(stops));
    const bend = { latitude: 40.7, longitude: -4.2 };
    r.nav.route = { key: '80:3' }; r.nav.points = [origin, bend, stops[0], stops[1]];
    r.ui.update(r.nav, { location: origin }, true); insideFrame(r.ui.state, r.nav.points);
    assert.deepEqual(scene.markers(r.ui.state).map((m) => m.kind), ['origin', 'number', 'destination']);
    assert.equal(r.ui.state.preferences.arrival, 15);
    assert(!r.sent.some((c) => c.action === 'start')); r.ui.close();
});
test('route subpages and adding a stop preserve the existing destination intent and need explicit Start', () => {
    const r = rig(); r.ui.activate('route-panel');
    const plan = { key: '80:3', arrival: 15, charging: true }, stops = [results[6]];
    r.receive({ status: 'preview', stops, plan });
    r.tap('route-page:battery'); assert.equal(r.ui.state.routePage, 'battery');
    r.tap('arrival-up'); assert.equal(r.ui.state.preferences.arrival, 20);
    r.tap('back'); assert.equal(r.ui.state.routePage, 'summary');
    r.tap('add-stop-search'); assert.equal(r.ui.state.addingStop, true);
    r.ui.state.query = 'Área de recarga'; r.tap('submit'); r.receive({ stops, plan });
    r.tap('result:11:0'); r.receive({ status: 'detail', stops, plan, selected: Object.assign({ address: { test: true }, phone: '' }, results[0]) });
    r.tap('add-stop'); assert.equal(r.sent[r.sent.length - 1].action, 'add-stop');
    assert(!r.sent.some((c) => c.action === 'start')); r.ui.close();
});
test('all panels keep touch controls in the map, outside home, including both keyboard pages and themes', () => {
    const r = rig(); r.receive({ stops: results.slice(0, 7), plan: { key: '80:3', arrival: 15, charging: true } });
    for (const theme of ['day', 'night']) for (const panel of ['none', 'search', 'detail', 'route', 'settings', 'recent', 'stop']) {
        for (const page of ['summary', 'stops', 'battery']) {
            Object.assign(r.ui.state, { theme, panel, routePage: page, keyboard: panel === 'search' && page !== 'summary', keyboardNumbers: page === 'battery', searchKind: 'chargers' });
            r.draw();
            for (const b of r.ui.state.buttons) {
                assert(b.x >= map.x && b.y >= map.y && b.x + b.w <= map.x + map.w && b.y + b.h <= map.y + map.h, panel + ':' + b.id);
                assert(!contains(home, b.x + b.w / 2, b.y + b.h / 2));
            }
        }
    }
    r.ui.close();
});
test('partial coordinates never create a marker; fitting the antimeridian uses the free panel viewport', () => {
    const r = rig(); r.ui.activate('chargers');
    r.receive({ results: [{ id: '11:0', name: 'Sin posición', type: 'charger', metres: null }, results[1]] });
    assert.equal(scene.markers(r.ui.state).length, 1); insideFrame(r.ui.state, [results[1]]);
    const points = [{ latitude: 10, longitude: 179.9 }, { latitude: 10.1, longitude: -179.9 }];
    r.ui.state.camera = fit(points, layout.viewport(r.ui.state)); insideFrame(r.ui.state, points);
    assert(r.ui.state.camera.zoom > 8); r.ui.close();
});

test('reference keyboard edits at the cursor, clears text and submits only on the primary action', () => {
    const r = rig(); r.tap('search');
    for (const letter of 'MADRID') r.ui.activate('key:' + letter);
    r.tap('cursor-left'); r.tap('erase'); r.ui.activate('key:Í');
    assert.equal(r.ui.state.query, 'MADRÍD'); assert.equal(r.sent.length, 0);
    r.tap('cursor-right'); r.tap('key: '); r.ui.activate('key:2');
    assert.equal(r.ui.state.query, 'MADRÍD 2');
    r.tap('clear'); assert.equal(r.ui.state.query, ''); assert.equal(r.ui.state.cursor, 0);
    r.ui.activate('key:A'); r.tap('keyboard-done'); assert.equal(r.sent[0].query, 'A'); r.ui.close();
});

test('busy actions keep their search kind and returning to the vehicle closes panels', () => {
    const r = rig(); r.ui.activate('search'); r.ui.state.query = 'Madrid'; r.ui.activate('submit');
    r.ui.activate('chargers'); assert.equal(r.ui.state.searchKind, 'text'); assert.equal(r.sent.length, 1);
    r.receive(); r.ui.tiles.status = () => ({ ready: true }); r.tap('center');
    assert.equal(r.ui.state.panel, 'none'); assert.equal(r.ui.state.follow, true); r.ui.close();
});

test('closing a preview restores the active BMW route, not the private preview stops', () => {
    const r = rig(); r.ui.activate('route-panel');
    r.receive({ status: 'preview', stops: [results[8]], plan: { key: '80:3', arrival: 15, charging: true } });
    r.nav.route = { key: '10:2' }; r.nav.points = [origin, results[1]];
    r.nav.destinations = [{ final: true, position: results[1] }];
    r.ui.update(r.nav, { location: origin }, true);
    assert.deepEqual(scene.routePoints(r.ui.state), []);
    r.ui.activate('close'); assert.deepEqual(scene.routePoints(r.ui.state), r.nav.points);
    assert.equal(scene.stops(r.ui.state)[0].latitude, results[1].latitude); r.ui.close();
});
