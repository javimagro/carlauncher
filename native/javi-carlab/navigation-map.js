'use strict';

const { map } = require('./drivehub-state');
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function world(point, zoom) {
    const scale = 256 * Math.pow(2, zoom), lat = clamp(point.latitude, -85.05112878, 85.05112878) * Math.PI / 180;
    return [(point.longitude + 180) / 360 * scale, (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * scale];
}
function geo(x, y, zoom) {
    const scale = 256 * Math.pow(2, zoom);
    return { longitude: ((x / scale * 360) % 360 + 360) % 360 - 180,
        latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * clamp(y / scale, 0, 1)))) * 180 / Math.PI };
}
function project(point, camera) {
    const a = world(point, camera.zoom), c = world(camera, camera.zoom), size = 256 * Math.pow(2, camera.zoom);
    let dx = a[0] - c[0];
    if (dx > size / 2) dx -= size;
    if (dx < -size / 2) dx += size;
    const box = camera.viewport || map;
    return [box.x + box.w / 2 + dx, box.y + box.h / 2 + a[1] - c[1]];
}
function clipSegment(a, b, box) {
    // Liang-Barsky: keep software previews and GPU coordinates bounded at street zoom.
    let low = 0, high = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy], q = [a[0] - box.x, box.x + box.w - a[0], a[1] - box.y, box.y + box.h - a[1]];
    for (let i = 0; i < 4; i++) {
        if (!p[i]) { if (q[i] < 0) return null; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) low = Math.max(low, r); else high = Math.min(high, r);
        if (low > high) return null;
    }
    return [[a[0] + low * dx, a[1] + low * dy], [a[0] + high * dx, a[1] + high * dy]];
}
function fit(points, viewport) {
    points = points.filter((p) => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
        Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180);
    if (!points.length) return null;
    const box = viewport || { x: map.x + 110, y: map.y + 105, w: map.w - 220, h: map.h - 210 };
    const anchor = world(points[0], 0)[0];
    const xy = points.map((p) => { const q = world(p, 0); q[0] = anchor + ((q[0] - anchor + 384) % 256 - 128); return q; });
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    const l = Math.min.apply(null, xs), r = Math.max.apply(null, xs), t = Math.min.apply(null, ys), b = Math.max.apply(null, ys);
    return Object.assign(geo((l + r) / 2, (t + b) / 2, 0), {
        zoom: points.length === 1 ? 16 : clamp(Math.floor(Math.log2(Math.min((box.w - 64) / Math.max(r - l, 0.0001), (box.h - 64) / Math.max(b - t, 0.0001)))), 1, 18),
        viewport: viewport || map });
}
// No raster provider or external cache is reachable from BMW navigation.
// A native MapViewer instance must be verified before this capability is enabled.
// Keep this explicit: route geometry is not a replacement for BMW cartography.
function createMap() {
    return {
        update() {},
        draw() {},
        status() {
            return { source: 'bmw-local', ready: false, loading: false,
                code: 'BMW_MAP_INSTANCE_UNAVAILABLE',
                issue: 'Mapa BMW no disponible',
                detail: 'La vista del mapa local todavía no está integrada',
                palette: 'unavailable', profile: null, mapVersion: null };
        },
        close() {}
    };
}
module.exports = { world, geo, project, fit, createMap, clipSegment };
