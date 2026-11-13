'use strict';

const { map } = require('./drivehub-state');
const palettes = {
    day: { ground: '#E4EFE4', surface: '#F5F7FA', control: '#E6EDF5', text: '#182A3E', secondary: '#506278', line: '#BDCBDC', accent: '#1976D2', eta: '#426E1E' },
    night: { ground: '#182A35', surface: '#1B2A3D', control: '#23354A', text: '#F4F7FB', secondary: '#C7D4E1', line: '#3D5067', accent: '#8DC8FF', eta: '#C9E59B' }
};
const shorten = (s, n) => String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || '');
function icon(cv, id, x, y, color) {
    const line = (points) => cv.polyline(points.map((p) => [x + p[0], y + p[1]]), 3, color);
    if (id === 'settings') {
        cv.arc(x, y, 7, 13, 0, 360, color);
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; cv.line(x + Math.cos(a) * 11, y + Math.sin(a) * 11, x + Math.cos(a) * 17, y + Math.sin(a) * 17, 5, color); }
    } else if (id === 'recent') { cv.arc(x, y, 13, 15, 0, 360, color); line([[0, -9], [0, 0], [7, 4]]); }
    else if (id === 'chargers') { cv.strokeRoundRect(x - 12, y - 15, 24, 30, 3, 2, color); line([[1, -10], [-5, 1], [2, 1], [-1, 11], [7, -2], [0, -2]]); }
    else if (id === 'center') { cv.arc(x, y, 8, 11, 0, 360, color); line([[-18, 0], [-10, 0]]); line([[10, 0], [18, 0]]); line([[0, -18], [0, -10]]); line([[0, 10], [0, 18]]); }
    else if (id === 'fit') { [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => line([[a * 5, b * 14], [a * 14, b * 14], [a * 14, b * 5]])); }
    else if (id === 'page-up' || id === 'page-down') { const d = id === 'page-up' ? -1 : 1; line([[0, -12 * d], [0, 12 * d]]); line([[-9, 3 * d], [0, 12 * d], [9, 3 * d]]); }
    else if (id === 'zoom-in' || id === 'zoom-out') { line([[-11, 0], [11, 0]]); if (id === 'zoom-in') line([[0, -11], [0, 11]]); }
    else return false;
    return true;
}
function controls(cv, ui, nav) {
    const s = ui.state, data = s.controls || {}, p = palettes[s.theme === 'auto' ? nav.theme === 'day' ? 'day' : 'night' : s.theme];
    s.buttons = [];
    function button(id, text, x, y, w, h, primary, disabled) {
        const b = { id, x, y, w, h, disabled: !!disabled }; s.buttons.push(b);
        cv.roundRect(x, y, w, h, 10, primary ? p.accent : p.control);
        if (s.focus === id) cv.strokeRoundRect(x - 2, y - 2, w + 4, h + 4, 12, 3, p.accent);
        const ink = disabled ? p.secondary : primary ? (p === palettes.day ? '#FFFFFF' : '#102035') : p.text;
        if (!(w < 70 && icon(cv, id, x + w / 2, y + h / 2, ink))) cv.text(text, x + w / 2, y + h / 2 + 7, 20, ink, { align: 'center' });
        return b;
    }
    function line(text, x, y, size, muted) { cv.text(text, x, y, size || 21, muted ? p.secondary : p.text); }
    // Carlinkit reference: separate narrow map toolbar, top search, bottom trip progress.
    const left = map.x + 12;
    cv.roundRect(left, map.y + 12, 58, 362, 14, p.surface);
    [['settings', '⚙'], ['recent', '★'], ['chargers', 'ϟ'], ['fit', 'Ruta'], ['center', '◎'], ['zoom-in', '+'], ['zoom-out', '−']].forEach((item, i) =>
        button(item[0], item[1], left + 3, map.y + 16 + i * 50, 52, 44));
    if (s.panel === 'none') {
        if (nav.state === 'active' && nav.instruction) {
            const turn = nav.instruction, x = map.x + 86, y = map.y + 12;
            const labels = { STRAIGHT_ON: 'Continúa recto', LEFT: 'Gira a la izquierda', HARD_LEFT: 'Gira a la izquierda', SLIGHT_LEFT: 'Mantente a la izquierda', RIGHT: 'Gira a la derecha', HARD_RIGHT: 'Gira a la derecha', SLIGHT_RIGHT: 'Mantente a la derecha', UTURN_LEFT: 'Cambia de sentido', UTURN_RIGHT: 'Cambia de sentido', NONE: 'Continúa por la ruta' };
            const title = turn.kind === 'roundabout' ? 'Rotonda' + (turn.exit ? ' · salida ' + turn.exit : '') : turn.kind === 'destinationManeuver' ? 'Llegada al destino' : labels[turn.direction] || 'Continúa por la ruta';
            const metres = turn.metres === null ? '' : turn.metres >= 1000 ? (turn.metres / 1000).toFixed(1).replace('.', ',') + ' km' : Math.round(turn.metres) + ' m';
            cv.roundRect(x, y, 590, 88, 12, '#008A92');
            cv.text(title, x + 18, y + 34, 25, '#FFFFFF', { font: 'bold' });
            cv.text(shorten(turn.road, 38), x + 18, y + 65, 20, '#FFFFFF');
            cv.text(metres, x + 574, y + 34, 25, '#FFFFFF', { align: 'right' });
            button('search', 'Buscar', x + 600, y, 120, 52);
        } else button('search', 'Buscar destino o lugar', map.x + 86, map.y + 12, 510, 52);
        if (nav.state === 'active') {
            const final = nav.destinations.find((d) => d.final), last = nav.segments[nav.segments.length - 1];
            const mins = final && Number.isFinite(final.seconds) ? Math.ceil(final.seconds / 60) : null;
            const duration = mins === null ? 'Calculando llegada' : mins >= 60 ? Math.floor(mins / 60) + ' h ' + mins % 60 + ' min' : mins + ' min';
            const distance = final && Number.isFinite(final.metres) ? (final.metres / 1000).toFixed(1).replace('.', ',') + ' km' : 'Distancia sin dato';
            const x = map.x + 86, y = map.y + map.h - 106;
            cv.roundRect(x, y, 660, 78, 12, p.surface);
            cv.text(duration, x + 16, y + 30, 26, p.eta, { font: 'bold' });
            line(distance + (last ? '  ·  ' + shorten(last.name, 24) : ''), x + 16, y + 59, 18, true);
            button('stop', 'Finalizar', x + 382, y + 12, 112, 52);
            button('route-panel', 'Ruta', x + 504, y + 12, 140, 52);
        }
    } else {
        const x = map.x + 86, y = map.y + 12, w = 732, h = map.h - 42;
        cv.roundRect(x, y, w, h, 15, p.surface);
        const titles = { search: 'Buscar', detail: 'Destino', route: 'Navegación', settings: 'Ajustes de navegación', recent: 'Destinos guardados', stop: 'Finalizar navegación' };
        button('back', '‹', x + 8, y + 8, 48, 48);
        line(titles[s.panel] || 'Navegación', x + 70, y + 40, 26);
        button('close', '×', x + w - 56, y + 8, 48, 48);
        cv.line(x + 16, y + 64, x + w - 16, y + 64, 1, p.line);
        const busy = s.pending || data.busy;
        if (s.panel === 'search') {
            button('query', shorten(s.query || 'Dirección, ciudad o punto de interés', 44), x + 12, y + 74, w - 142, 50);
            button('submit', 'Buscar', x + w - 120, y + 74, 108, 50, true, busy || !s.query.trim());
            if (s.keyboard) {
                const rows = s.keyboardNumbers ? ['1234567890', '-/.,:;()@&', 'ÁÉÍÓÚÜÑ?!'] : ['QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM'];
                rows.forEach((row, r) => {
                    const keyW = 62, gap = 7, total = row.length * (keyW + gap) - gap;
                    const start = x + (w - total) / 2;
                    row.split('').forEach((key, index) => button('key:' + key, key, start + index * (keyW + gap), y + 140 + r * 58, keyW, 50));
                });
                button('numbers', s.keyboardNumbers ? 'ABC' : '123', x + 18, y + 320, 106, 50);
                button('key: ', 'Espacio', x + 134, y + 320, 336, 50);
                button('erase', 'Borrar', x + 480, y + 320, 108, 50);
                button('query', 'Listo', x + 598, y + 320, 116, 50);
            } else {
                const list = data.results || [];
                s.offset = Math.max(0, Math.min(s.offset, Math.max(0, list.length - 4)));
                list.slice(s.offset, s.offset + 4).forEach((item, i) => {
                    const yy = y + 136 + i * 58;
                    button('result:' + item.id, shorten(item.name, 43), x + 12, yy, w - 88, 50, false, busy);
                });
                button('page-up', '↑', x + w - 64, y + 136, 50, 50, false, !s.offset);
                button('page-down', '↓', x + w - 64, y + 194, 50, 50, false, s.offset + 4 >= list.length);
                if (!list.length) line(busy || data.status === 'loading' ? 'Buscando en BMW Maps…' : data.status === 'results' ? 'No se han encontrado resultados' : 'Escribe un destino o busca cargadores', x + 22, y + 175, 21, true);
            }
        } else if (s.panel === 'detail') {
            const selected = data.selected || {};
            line(shorten(selected.name, 44), x + 22, y + 111, 26);
            if (Number.isFinite(selected.latitude)) line(selected.latitude.toFixed(5) + ', ' + selected.longitude.toFixed(5), x + 22, y + 148, 19, true);
            const saved = selected.address && s.favorites.some((f) => JSON.stringify(f.address) === JSON.stringify(selected.address));
            button('save-destination', saved ? 'Quitar guardado' : 'Guardar', x + w - 210, y + 130, 188, 48, false, !selected.address);
            if (selected.phone) line(selected.phone, x + 22, y + 184, 21, true);
            if (selected.details && selected.details.length) selected.details.slice(0, 2).forEach((text, i) => line(shorten(text, 58), x + 22, y + 218 + i * 28, 18, true));
            else line('Destino obtenido de BMW Maps', x + 22, y + 230, 18, true);
            button('route', 'Calcular ruta', x + 22, y + 272, 324, 58, true, busy);
            button('add-stop', 'Añadir parada', x + 358, y + 272, 350, 58, false, busy || !(data.stops || []).length);
        } else if (s.panel === 'route') {
            const stops = data.stops && data.stops.length ? data.stops : nav.segments || [];
            line('Desde tu ubicación actual', x + 28, y + 102, 22, true);
            stops.slice(0, 4).forEach((stop, i) => {
                cv.circle(x + 30, y + 143 + i * 46, 6, stop.charging ? '#4C98F7' : i === stops.length - 1 ? '#E53935' : p.accent);
                line(shorten(stop.name || (stop.charging ? 'Parada de carga' : 'Destino'), 46), x + 52, y + 150 + i * 46, 22);
            });
            if (busy || data.status === 'calculating') line('BMW está calculando la ruta y las recargas…', x + 24, y + 284, 20, true);
            else if (data.plan) {
                const prefix = Number.isFinite(data.plan.metres) ? (data.plan.metres / 1000).toFixed(1).replace('.', ',') + ' km · ' + Math.ceil(data.plan.seconds / 60) + ' min · ' : '';
                line(prefix + (data.plan.charging ? 'Llegada mínima ' + data.plan.arrival + '%' : 'Sin recargas automáticas'), x + 24, y + 284, 19, true);
            }
            button('search', 'Añadir destino', x + 18, y + 314, 220, 56);
            button('settings', 'Opciones', x + 248, y + 314, 210, 56);
            button('start', 'Iniciar', x + 468, y + 314, 246, 56, true, busy || !data.plan || data.status !== 'preview');
        } else if (s.panel === 'settings') {
            [['charging', 'Añadir paradas de carga'], ['tolls', 'Utilizar peajes'], ['motorways', 'Utilizar autopistas']].forEach(([key, label], i) => {
                line(label, x + 20, y + 101 + i * 56, 22);
                button('pref:' + key, s.preferences[key] ? 'Sí' : 'No', x + w - 110, y + 76 + i * 56, 90, 44);
            });
            line('Batería mínima al destino', x + 20, y + 269, 22);
            button('arrival-down', '−', x + 454, y + 244, 52, 44);
            line(s.preferences.arrival + '%', x + 524, y + 274, 23);
            button('arrival-up', '+', x + 628, y + 244, 52, 44);
            button('theme', 'Tema: ' + ({ auto: 'Automático', day: 'Día', night: 'Noche' })[s.theme], x + 20, y + 302, 330, 50);
            button('recalculate', 'Aplicar a esta ruta', x + 362, y + 302, 350, 50, true, busy || !(data.stops || []).length);
            line('Las opciones se aplican al calcular una ruta aquí.', x + 20, y + 385, 17, true);
        } else if (s.panel === 'recent') {
            const isFavorite = s.savedTab === 'favorites', list = isFavorite ? s.favorites : s.recent;
            button('saved-recent', 'Recientes', x + 16, y + 78, 340, 48, !isFavorite);
            button('saved-favorites', 'Favoritos', x + 368, y + 78, 348, 48, isFavorite);
            s.offset = Math.min(s.offset, Math.max(0, list.length - 4));
            list.slice(s.offset, s.offset + 4).forEach((item, i) => button((isFavorite ? 'favorite:' : 'history:') + (s.offset + i), shorten(isFavorite ? item.name : item, 44), x + 16, y + 138 + i * 60, w - 100, 52));
            button('page-up', '↑', x + w - 70, y + 138, 52, 50, false, !s.offset);
            button('page-down', '↓', x + w - 70, y + 198, 52, 50, false, s.offset + 4 >= list.length);
            if (!list.length) line(isFavorite ? 'Guarda un destino desde su ficha.' : 'Aquí aparecerán tus búsquedas recientes.', x + 24, y + 174, 21, true);
        } else if (s.panel === 'stop') {
            line('¿Finalizar el guiado de BMW Maps?', x + 24, y + 142, 25);
            button('confirm-stop', 'Finalizar ruta', x + 24, y + 220, 324, 58, true, busy);
            button('close', 'Continuar', x + 362, y + 220, 346, 58);
        }
        if (data.status === 'error' || s.message) {
            cv.roundRect(x + 12, y + h - 46, w - 24, 36, 8, p.control);
            line(shorten(s.message || 'BMW: ' + data.error, 64), x + 24, y + h - 21, 17, true);
        }
    }
    // Always visible: never put attribution under a menu or the lower energy bar.
    cv.fillRect(map.x + 74, map.y + map.h - 24, map.w - 148, 24, p.surface);
    line('(c) OpenStreetMap contributors · Rutas y destinos: BMW', map.x + 86, map.y + map.h - 7, 14, true);
    return p;
}
module.exports = { controls, palettes, shorten };
