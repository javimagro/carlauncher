'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { createAAUI } = require('../../native/javi-carlab/aa-ui');
const { drawAA, drawSource, drawSettings, drawMenu, layout, menuActions } = require('../../native/javi-carlab/aa-view');
const { map, home, viewport, preconditioningButton, energyBar } = require('../../native/javi-carlab/drivehub-state');
const { toggle } = require('../../native/javi-carlab/navigation-view');
const { geometry, resolveGeometry, fitGeometry } = require('../../native/javi-carlab/aa-frame');
function fixture() {
    const calls = [], state = { state: 'playing', inputReady: true }; let change;
    let frame = { id: 7, geometry };
    const adapter = {
        status: () => state, frame: () => frame, changed(cb) { change = cb; return () => calls.push(['unwatch']); },
        ready(info) { calls.push(['ready', info]); }, setVisible(on) { calls.push(['visible', on]); },
        setInputFocus(on) { calls.push(['focus', on]); }, touch(phase, point) { calls.push(['touch', phase, point]); },
        controller(event) { calls.push(['controller', event]); }, close() { calls.push(['close']); }
    };
    const ui = createAAUI(adapter, () => {}, message => calls.push(['notice', message]), action => calls.push(['action', action]));
    return { adapter, ui, state, calls, refresh: () => change(), frame: value => { frame = value; } };
}
const tap = (ui, box) => { ui.touch('down', box.x + box.w / 2, box.y + box.h / 2); ui.touch('up', box.x + box.w / 2, box.y + box.h / 2); };
const choose = (ui, action) => { if (!ui.state.menu) tap(ui, layout.settings); tap(ui, layout[action]); };
test('AA uses the whole left panel without BMW controls and keeps actions below or beside the map', () => {
    const f = fixture(); f.ui.update(true, false, true);
    assert.equal(f.ui.state.source, 'aa'); assert.equal(f.ui.state.focus, 'drivehub');
    assert.deepEqual(layout.content, map); assert.equal(f.ui.state.header, false);
    assert(layout.settings.y >= map.y + map.h && layout.settings.y + layout.settings.h <= energyBar.y + energyBar.h);
    const boxes = menuActions.map(id => layout[id]);
    boxes.forEach((a, i) => boxes.slice(i + 1).forEach(b => assert(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)));
    boxes.forEach(box => assert(box.x >= viewport.x && box.x + box.w <= viewport.x + viewport.w && box.y >= viewport.y && box.y + box.h <= viewport.y + viewport.h));
    const draws = [], cv = { fillRect() {}, circle() {}, arc() {}, polyline() {}, roundRect() {}, strokeRoundRect() {}, text(...args) { draws.push(['text', ...args]); }, video(...args) { draws.push(['video', ...args]); } };
    drawAA(cv, f.ui, true); drawSource(cv, f.ui, true);
    const video = draws.find(x => x[0] === 'video'); assert.equal(video[1], 7);
    assert(Math.abs(video[4] / video[5] - 1920 / 560) < 1e-8);
    assert(video[2] >= map.x && video[2] + video[4] <= map.x + map.w);
    assert(video[3] >= layout.content.y && video[3] + video[5] <= map.y + map.h);
    assert(!draws.some(x => x[0] === 'text'), 'playing AA has no BMW header or Datos overlay');
    tap(f.ui, layout.settings); drawSettings(cv, f.ui); drawMenu(cv, f.ui, true, null, 1000);
    assert(draws.some(x => x[0] === 'text' && x[1] === 'Datos del coche'));
    tap(f.ui, layout.bmw); assert.equal(f.ui.state.source, 'bmw'); assert.deepEqual(f.calls.filter(x => x[0] === 'visible'), [['visible', true], ['visible', false]]);
    f.ui.update(true, false, true); assert(f.ui.state.header); tap(f.ui, layout.source); assert.equal(f.ui.state.source, 'aa');
    f.ui.update(true, false, true); choose(f.ui, 'bmw');
    f.ui.update(true, false, false); assert.equal(f.ui.state.header, false, 'BMW search panel keeps its own header'); f.ui.close();
    assert.equal(createAAUI().state.source, 'bmw');
});
test('AA sends bounded content coordinates, owns a gesture, and releases it before hiding', () => {
    const f = fixture(); f.ui.update(true, false, true);
    const b = layout.content, x = b.x + b.w / 2, y = b.y + b.h / 2;
    f.ui.touch('down', x, b.y + 1); f.ui.touch('up', x, b.y + 1);
    assert.equal(f.calls.filter(x => x[0] === 'touch').length, 0, 'letterbox is not touch input');
    assert(f.ui.touch('down', x, y)); assert.equal(f.ui.state.focus, 'aa');
    assert.deepEqual(f.calls.find(x => x[0] === 'touch')[2], { x: 960, y: 540, contentX: 960, contentY: 280 });
    assert(f.ui.touch('move', viewport.x + 100, 900));
    const last = f.calls.filter(x => x[0] === 'touch').at(-1)[2]; assert.equal(last.x, 1919); assert.equal(last.y, 819);
    f.ui.update(false, false, false);
    const cancellation = f.calls.findIndex(x => x[0] === 'touch' && x[1] === 'cancel');
    assert(cancellation >= 0 && cancellation < f.calls.findIndex(x => x[0] === 'visible' && !x[1]));
    assert.equal(f.ui.controller({ knob: 100 }), false); f.ui.close();
});

test('AA draws and touches the same negotiated frame geometry without changing the HMI coordinate contract', () => {
    const f = fixture(), selected = resolveGeometry({ display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580 });
    f.frame({ id: 7, geometry: selected }); f.ui.update(true, false, true);
    const draws = [], cv = { roundRect() {}, text() {}, video(...args) { draws.push(args); } };
    drawAA(cv, f.ui, true);
    const box = fitGeometry(layout.content, selected);
    assert.deepEqual(draws, [[7, box.x, box.y, box.w, box.h]]);
    f.ui.touch('down', box.x + box.scale / 4, box.y + box.scale / 4);
    f.ui.touch('up', box.x + box.scale / 4, box.y + box.scale / 4);
    assert.deepEqual(f.calls.filter(x => x[0] === 'touch').map(x => x[2]), [
        { x: 376, y: 250, contentX: 0, contentY: 0 }, { x: 376, y: 250, contentX: 0, contentY: 0 }
    ]);
    f.ui.close();
});

test('AA cancels with the old point when its displayed frame changes mid-gesture', () => {
    const f = fixture(); f.ui.update(true, false, true);
    const b = layout.content; f.ui.touch('down', b.x + b.w / 2, b.y + b.h / 2);
    f.frame({ id: 7, geometry: resolveGeometry({ display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580 }) });
    f.ui.touch('move', b.x + 20, b.y + 20); f.ui.touch('up', b.x + 20, b.y + 20);
    const input = f.calls.filter(x => x[0] === 'touch');
    assert.deepEqual(input.map(x => x[1]), ['down', 'cancel']); assert.deepEqual(input[1][2], input[0][2]);
    f.frame({ id: 7 }); tap(f.ui, b);
    assert.equal(f.calls.filter(x => x[0] === 'touch').length, 2, 'a frame with no geometry never assumes the default crop');
    f.ui.close();
});
test('AA controller selection is explicit and unavailable input never falls through to DriveHub', () => {
    const f = fixture(); f.ui.update(true, false, true);
    assert.equal(f.ui.controller({ knob: 1 }), false);
    choose(f.ui, 'focus-aa'); assert.equal(f.ui.state.focus, 'aa');
    assert(f.ui.controller({ knob: 2 })); assert.equal(f.calls.filter(x => x[0] === 'controller').length, 1);
    f.state.inputReady = false; f.refresh();
    assert(f.ui.controller({ knob: 3 })); assert.equal(f.calls.filter(x => x[0] === 'controller').length, 1);
    f.ui.touch('down', viewport.x + 5, viewport.y + 5); assert.equal(f.ui.state.focus, 'drivehub');
    assert.equal(f.ui.controller({ knob: 4 }), false); choose(f.ui, 'focus-aa');
    assert.equal(f.ui.state.focus, 'drivehub'); assert(f.calls.some(x => x[0] === 'notice'));
    f.ui.close(); f.refresh(); assert.equal(f.calls.filter(x => x[0] === 'close').length, 1);
});
test('AA cancels ongoing input on lost readiness and diagnostics suspend capture without changing source', () => {
    const f = fixture(); f.ui.update(true, false, true);
    f.ui.touch('down', layout.content.x + layout.content.w / 2, layout.content.y + layout.content.h / 2);
    f.state.state = 'recovery-needed'; f.refresh();
    assert(f.calls.some(x => x[0] === 'touch' && x[1] === 'cancel'));
    f.ui.update(true, true, true); assert.equal(f.ui.state.header, false); assert.equal(f.ui.state.source, 'aa');
    assert.equal(f.ui.frame(), false);
    f.state.state = 'playing'; f.ui.update(true, false, true); assert(f.ui.frame()); f.ui.close();
});

test('AA restores retained input focus after a delayed worker ACK without repeated focus writes', () => {
    const f = fixture(); f.ui.update(true, false, true); choose(f.ui, 'focus-aa');
    assert.equal(f.ui.state.focus, 'aa');
    f.state.inputReady = false; f.refresh();
    f.state.inputReady = true;
    for (let n = 0; n < 20; n++) f.ui.update(true, false, true);
    assert.deepEqual(f.calls.filter(c => c[0] === 'focus'), [['focus', true], ['focus', false], ['focus', true]]);
    f.state.inputReady = false; f.ui.update(true, false, true);
    assert.deepEqual(f.calls.filter(c => c[0] === 'focus').at(-1), ['focus', false]);
    f.ui.close();
});

test('the first AA tap after readiness returns refreshes an unchanged AA focus immediately', () => {
    const f = fixture(); f.ui.update(true, false, true); choose(f.ui, 'focus-aa');
    f.state.inputReady = false; f.refresh(); f.state.inputReady = true;
    const before = f.calls.length;
    tap(f.ui, layout.content);
    const resumed = f.calls.slice(before);
    assert.deepEqual(resumed[0], ['focus', true]);
    assert.equal(resumed[1][0], 'touch'); assert.equal(resumed[1][1], 'down');
    f.ui.close();
});
test('AA menu owns touch and knob temporarily, restores focus and never stops video', () => {
    const f = fixture(); f.ui.update(true, false, true); tap(f.ui, layout.content);
    assert.equal(f.ui.state.focus, 'aa'); tap(f.ui, layout.settings);
    assert.equal(f.ui.ownsInput(), false); assert.deepEqual(f.calls.filter(x => x[0] === 'focus').at(-1), ['focus', false]);
    assert(f.ui.frame()); assert.equal(f.calls.filter(x => x[0] === 'visible').length, 1);
    f.ui.controller({ knob: 10, press: 0 }); f.ui.controller({ knob: 14, press: 0 });
    assert.equal(menuActions[f.ui.state.menuIndex], 'diagnostics');
    f.ui.controller({ knob: 14, press: 1 }); f.ui.controller({ knob: 14, press: 0 });
    assert.deepEqual(f.calls.filter(x => x[0] === 'action'), [['action', 'diagnostics']]);
    assert.equal(f.calls.filter(x => x[0] === 'controller').length, 0);
    assert.equal(f.ui.state.menu, false); assert.equal(f.ui.ownsInput(), true);
    tap(f.ui, layout.settings); const before = f.calls.filter(x => x[0] === 'touch').length;
    tap(f.ui, layout.content); assert.equal(f.ui.state.menu, false);
    assert.equal(f.calls.filter(x => x[0] === 'touch').length, before, 'closing outside must not tap the phone');
    choose(f.ui, 'home'); choose(f.ui, 'precondition');
    assert.deepEqual(f.calls.filter(x => x[0] === 'action').slice(-2), [['action', 'home'], ['action', 'precondition']]);
    f.ui.close();
});

test('session routes AA settings to Datos/home without hidden BMW hotspots and releases covered AA', async t => {
    const createSession = require('../../native/javi-carlab/drivehub-session');
    const f = fixture(), gpu = new EventEmitter(); let exits = 0;
    Object.assign(gpu, { place() {}, claim() {}, show() {}, grab() {}, frame() {}, close() {} });
    const session = createSession(gpu, { aa: f.adapter, fixture: { news: [] }, area: () => ({ scale: 1 }), onExit() { exits++; } });
    t.after(() => { session.close(); f.ui.close(); });
    gpu.emit('ready', {}, { controller: true, touch: true, video: true }); session.show(true); gpu.emit('state', { onScreen: true });
    // Telemetry marks the first confirmed frame dirty without waiting for the normal idle redraw.
    session.telemetry([], null); await delay(70);
    assert(f.calls.some(x => x[0] === 'visible' && x[1]));
    const touch = box => { gpu.emit('touch', 'down', box.x + 5, box.y + 5); gpu.emit('touch', 'up', box.x + 5, box.y + 5); };
    touch(home); touch(toggle); touch(preconditioningButton);
    assert.equal(exits, 0, 'old BMW controls must have no invisible hotspots over AA');
    touch(layout.settings); touch(layout.diagnostics); await delay(60); assert.deepEqual(f.calls.filter(x => x[0] === 'visible').at(-1), ['visible', false]);
    touch(toggle); await delay(60); assert.deepEqual(f.calls.filter(x => x[0] === 'visible').at(-1), ['visible', true]);
    touch(layout.settings); touch(layout.home); assert.equal(exits, 1);
    gpu.emit('state', { onScreen: false }); assert.deepEqual(f.calls.filter(x => x[0] === 'visible').at(-1), ['visible', false]);
});
