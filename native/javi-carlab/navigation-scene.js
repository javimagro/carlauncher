'use strict';

const layout = require('./navigation-layout');
const { fit, project } = require('./navigation-map');
const valid = (p) => p && Number.isFinite(p.latitude) && Number.isFinite(p.longitude);
const noPoints = [];
function routePoints(s) {
    const nav = s.nav || {}, plan = s.controls && s.controls.plan;
    // An active route export must never stand in for a different calculated preview.
    if (s.panel === 'route' && s.controls && s.controls.status === 'calculating') return noPoints;
    return s.panel !== 'route' || !plan || nav.route && plan.key === nav.route.key ? nav.points || noPoints : noPoints;
}
function stops(s) {
    const data = s.controls || {}, nav = s.nav || {};
    const active = (nav.destinations || []).filter((d) => valid(d.position)).map((d, i) =>
        Object.assign({ name: (nav.segments || [])[i] && nav.segments[i].name, charging: d.charging }, d.position));
    if (s.panel === 'none') return active;
    return data.plan ? data.stops || [] : active.length ? active : data.stops || [];
}
function targets(s) {
    if (s.panel === 'search' && !s.keyboard) return layout.visibleResults(s).filter(valid);
    if (s.panel === 'detail') return [s.controls && s.controls.selected].filter(valid);
    return routePoints(s).concat(stops(s)).concat(s.location ? [s.location] : []);
}
function frame(s) {
    const camera = fit(targets(s), layout.viewport(s));
    if (camera) { s.camera = camera; s.follow = false; }
    return camera;
}
function markers(s) {
    if (s.panel === 'search' && !s.keyboard) return layout.visibleResults(s).filter(valid).map((r) =>
        Object.assign({}, r, { action: 'result:' + r.id, kind: 'number', label: String(r.number) }));
    if (s.panel === 'detail') {
        const selected = s.controls && s.controls.selected;
        return valid(selected) ? [Object.assign({}, selected, { kind: selected.type === 'charger' ? 'charge' : 'destination' })] : [];
    }
    const list = stops(s).filter(valid).map((p, i, all) => Object.assign({}, p,
        { kind: i === all.length - 1 ? 'destination' : p.charging ? 'charge' : 'number', label: String(i + 1) }));
    if (s.location && list.length) list.unshift(Object.assign({ kind: 'origin' }, s.location));
    return list;
}
function hits(s) {
    if (!s.camera) return [];
    const v = layout.viewport(s);
    return markers(s).filter((m) => m.action).map((m) => {
        const p = project(m, s.camera);
        return { id: m.action, x: p[0] - 22, y: p[1] - 22, w: 44, h: 44 };
    }).filter((b) => b.x >= v.x && b.y >= v.y && b.x + b.w <= v.x + v.w && b.y + b.h <= v.y + v.h);
}
module.exports = { targets, frame, routePoints, stops, markers, hits };
