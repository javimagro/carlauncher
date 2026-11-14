'use strict';

const { map } = require('./drivehub-state');
// Carlinkit panel proportions, adapted to the 1038 x 468 logical map surface.
// Drawing, touch and camera padding share these bounds.
function panel(state) {
    const wide = state.keyboard || state.panel === 'detail' || state.panel === 'guidance-displays' || state.panel.indexOf('assistant') === 0;
    return { x: map.x + 78, y: map.y + 10,
        w: wide ? 744 : state.panel === 'route' ? 380 : 420,
        h: map.h - 38 };
}
function viewport(state) {
    const box = panel(state), inset = state.panel !== 'none' && !state.keyboard ? box.x + box.w + 18 : map.x + 78;
    return { x: inset, y: map.y + 64, w: map.x + map.w - 20 - inset, h: map.h - 112 };
}
function pageSize(state) { return state.panel === 'search' && state.searchKind === 'chargers' ? 2 : 4; }
function listBounds(state) {
    const b = panel(state);
    return { x: b.x + 12, y: b.y + 68, w: b.w - 32, h: b.h - 92 };
}
function visibleResults(state) {
    const list = state.controls && state.controls.results || [];
    const offset = Math.max(0, Math.min(state.offset, Math.max(0, list.length - pageSize(state))));
    return list.slice(offset, offset + pageSize(state)).map((item, i) => Object.assign({ number: offset + i + 1 }, item));
}
module.exports = { panel, viewport, pageSize, listBounds, visibleResults };
