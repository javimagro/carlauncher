'use strict';

const { map, home, contains } = require('./drivehub-state.js');
const mapDrawing = require('./navigation-map');
const panels = require('./navigation-panels');
const toggle = { x: map.x + map.w - 186, y: home.y, w: 110, h: home.h };
const controls = [
    { id: 'zoom-in', label: '+', x: map.x + map.w - 68, y: map.y + 156, w: 52, h: 48 },
    { id: 'zoom-out', label: '−', x: map.x + map.w - 68, y: map.y + 212, w: 52, h: 48 },
    { id: 'fit', label: 'Centrar', x: map.x + map.w - 124, y: map.y + 278, w: 108, h: 48 }
];
const palettes = {
    day: { ground: '#e9eef3', surface: '#ffffff', text: '#17212c', muted: '#4c5c6d', route: '#1967d2', edge: '#ffffff', charge: '#137333', line: '#ced7df' },
    night: { ground: '#202a35', surface: '#293747', text: '#f0f4f8', muted: '#b9c9d8', route: '#8ab4f8', edge: '#124b8b', charge: '#81c995', line: '#46576a' }
};
const center = { align: 'center' };
function button(cv, box, label, colors) {
    cv.roundRect(box.x, box.y, box.w, box.h, 8, colors.surface);
    cv.text(label, box.x + box.w / 2, box.y + box.h / 2 + 7, 18, colors.text, center);
}
function clipText(s, max) { return s.length <= max ? s : s.slice(0, max - 1) + '…'; }
function projection(points, zoom) {
    const anchor = points[0].longitude;
    const mercator = (p) => {
        let lng = p.longitude - anchor;
        while (lng > 180) lng -= 360;
        while (lng < -180) lng += 360;
        const lat = Math.max(-85, Math.min(85, p.latitude)) * Math.PI / 180;
        return [lng, -Math.log(Math.tan(Math.PI / 4 + lat / 2)) * 180 / Math.PI];
    };
    const xy = points.map(mercator);
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    const minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    const minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    const scale = Math.min(650 / Math.max(0.002, maxX - minX), 230 / Math.max(0.002, maxY - minY)) * zoom;
    const cx = map.x + (map.w - 130) / 2, cy = map.y + 238;
    const project = (p) => { const v = mercator(p); return [cx + (v[0] - (maxX + minX) / 2) * scale, cy + (v[1] - (maxY + minY) / 2) * scale]; };
    return { points: points.map(project), project };
}
function marker(cv, point, charging, colors) {
    const x = point[0], y = point[1];
    cv.roundRect(x - 14, y - 14, 28, 28, 14, colors.surface);
    if (charging) {
        cv.polyline([[x + 1, y - 9], [x - 5, y + 1], [x + 1, y + 1], [x - 1, y + 9], [x + 6, y - 2], [x, y - 2]], 3, colors.charge);
    } else cv.roundRect(x - 6, y - 6, 12, 12, 6, colors.route);
}
function drawNavigation(cv, nav, vehicle, zoom, now, ui) {
    nav = nav || { state: 'unavailable', points: [], destinations: [], segments: [] };
    if (ui) {
        const s = ui.state, night = (s.theme === 'auto' ? nav.theme : s.theme) !== 'day';
        const p = panels.palettes[night ? 'night' : 'day'];
        cv.roundRect(map.x, map.y, map.w, map.h, 10, p.ground);
        ui.tiles.draw(cv, night);
        if (s.camera) {
            cv.clip(map.x, map.y, map.w, map.h);
            if (nav.points.length) {
                const points = nav.points.map((point) => mapDrawing.project(point, s.camera));
                for (let i = 1; i < points.length; i++) {
                    const segment = mapDrawing.clipSegment(points[i - 1], points[i], { x: map.x - 12, y: map.y - 12, w: map.w + 24, h: map.h + 24 });
                    if (!segment) continue;
                    const a = segment[0], b = segment[1];
                    cv.line(a[0], a[1], b[0], b[1], 12, '#C7DAFF'); cv.line(a[0], a[1], b[0], b[1], 7, '#1967D2');
                }
                nav.destinations.forEach((d) => { if (d.position) marker(cv, mapDrawing.project(d.position, s.camera), d.charging,
                    { surface: p.surface, route: '#E53935', charge: '#4C98F7' }); });
            }
            const selected = s.controls && s.controls.selected;
            if (selected) marker(cv, mapDrawing.project(selected, s.camera), false, { surface: p.surface, route: '#E53935' });
            if (vehicle.location) {
                const point = mapDrawing.project(vehicle.location, s.camera);
                cv.circle(point[0], point[1], 13, '#FFFFFF'); cv.circle(point[0], point[1], 9, '#1976D2');
            }
            cv.noclip();
        }
        const status = ui.tiles.status();
        if (s.panel === 'none' && (!s.camera || !status.ready)) {
            cv.roundRect(map.x + 210, map.y + 172, 620, 88, 12, p.surface);
            cv.text(!s.camera ? 'Esperando posición GPS del coche' : status.issue || 'Cargando mapa…', map.x + 520, map.y + 212, 25, p.text, center);
            cv.text('Cartografía online · búsquedas y rutas de BMW', map.x + 520, map.y + 241, 18, p.secondary, center);
        }
        panels.controls(cv, ui, nav);
        button(cv, toggle, 'Datos', { surface: p.surface, text: p.text });
        return;
    }
    const colors = palettes[nav.theme === 'day' ? 'day' : 'night'];
    cv.roundRect(map.x, map.y, map.w, map.h, 10, colors.ground);
    cv.text('Navegación BMW', map.x + 22, map.y + 36, 25, colors.text, { font: 'bold' });
    cv.text('Vista de ruta · cartografía pendiente', map.x + 22, map.y + 61, 15, colors.muted);
    const final = nav.destinations.find((d) => d.final);
    const lastSegment = nav.segments[nav.segments.length - 1];
    const title = lastSegment && lastSegment.name || 'Destino de BMW Maps';
    if (nav.points.length) {
        const geometry = projection(nav.points, zoom || 1);
        cv.clip(map.x + 8, map.y + 80, map.w - 140, 294);
        cv.polyline(geometry.points, 12, colors.edge);
        cv.polyline(geometry.points, 7, colors.route);
        nav.destinations.forEach((d) => { if (d.position) marker(cv, geometry.project(d.position), d.charging, colors); });
        if (vehicle.location) {
            const p = geometry.project(vehicle.location);
            cv.roundRect(p[0] - 11, p[1] - 11, 22, 22, 11, colors.edge);
            cv.roundRect(p[0] - 7, p[1] - 7, 14, 14, 7, colors.route);
        }
        cv.noclip();
        controls.forEach((b) => button(cv, b, b.label, colors));
    } else {
        const headline = nav.state === 'inactive' ? 'Sin ruta activa en BMW Maps' : nav.state === 'calculating' ?
            'BMW está calculando la ruta' : nav.state === 'active' ? 'Esperando el trazado de BMW' : 'Esperando navegación del coche';
        const detail = nav.geometryError ? 'El trazado recibido no coincide con el destino.' : nav.routeStatus === 'unavailable' ?
            'BMW no ha permitido exportar el trazado.' : nav.state === 'inactive' ?
                'Inicia una ruta en BMW Maps y vuelve aquí.' : 'Las calles y los POI aún no están disponibles en esta vista.';
        cv.text(headline, map.x + map.w / 2, map.y + 218, 26, colors.text, center);
        cv.text(detail, map.x + map.w / 2, map.y + 253, 18, colors.muted, center);
    }
    const y = map.y + map.h - 86;
    cv.line(map.x + 20, y, map.x + map.w - 20, y, 1, colors.line);
    const charges = nav.destinations.filter((d) => d.charging).length;
    cv.text(nav.state === 'active' ? clipText(title, 46) : 'Ruta y paradas calculadas por BMW', map.x + 22, y + 29, 21, colors.text);
    const minutes = final && Number.isFinite(final.seconds) ? Math.ceil(final.seconds / 60) + ' min' : '–';
    const km = final && Number.isFinite(final.metres) ? (final.metres / 1000).toFixed(1).replace('.', ',') + ' km' : '–';
    cv.text(nav.state === 'active' ? km + '  ·  ' + minutes + '  ·  ' + (nav.destinationsKnown ? charges + ' paradas de carga' : 'Cargas: sin dato') :
        'Sin previsiones de llegada disponibles', map.x + 22, y + 60, 19, colors.muted);
    const pref = lastSegment && lastSegment.preferences;
    cv.text(nav.electricRouting === true ? 'Ruta eléctrica activada' : nav.electricRouting === false ? 'Ruta eléctrica desactivada' :
        'Ruta eléctrica: sin dato', map.x + map.w - 22, y + 29, 17, colors.text, { align: 'right' });
    if (pref && pref.arrivalMinimum !== null) cv.text('Mínimo al destino: ' + pref.arrivalMinimum + '%', map.x + map.w - 22, y + 60, 17, colors.muted, { align: 'right' });
    button(cv, toggle, 'Datos', colors);
}
function drawToggle(cv) { button(cv, toggle, 'Mapa', palettes.night); }
function actionAt(x, y, diagnostics, nav) {
    if (contains(toggle, x, y)) return 'toggle';
    if (!diagnostics && nav && nav.points.length) {
        const item = controls.find((b) => contains(b, x, y));
        return item ? item.id : null;
    }
    return null;
}
module.exports = { drawNavigation, drawToggle, actionAt, projection, palettes, toggle, controls };
