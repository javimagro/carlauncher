'use strict';

const { map, preconditioningButton } = require('./drivehub-state');
const layout = require('./navigation-layout');
const scene = require('./navigation-scene');
const { icon } = require('./navigation-icons');
const assistantPanel = require('./assistant-panel');
const displayPanel = require('./navigation-displays');
const palettes = {
    day: { ground: '#E8EEF5', surface: '#F5F7FA', control: '#E6EDF5', card: '#F1F4F8', text: '#182A3E', secondary: '#506278', line: '#BDCBDC', accent: '#7F9FC6', selected: '#B9CEE8', primaryText: '#183D68', eta: '#426E1E', good: '#27623D', warn: '#885800', danger: '#A82E37' },
    night: { ground: '#101B2B', surface: '#1B2A3D', control: '#23354A', card: '#162437', text: '#F4F7FB', secondary: '#C7D4E1', line: '#3D5067', accent: '#8DC8FF', selected: '#245B86', primaryText: '#F4F7FB', eta: '#C9E59B', good: '#9ED4AE', warn: '#F6C57A', danger: '#FFADB6' }
};
const shorten = (s, n) => String(s || '').length > n ? String(s).slice(0, n - 1) + '…' : String(s || '');
const distance = (v) => Number.isFinite(v) ? (v / 1000).toFixed(1).replace('.', ',') + ' km' : '— km';
function duration(seconds) {
    if (!Number.isFinite(seconds)) return '— min';
    const n = Math.ceil(seconds / 60);
    return n >= 60 ? Math.floor(n / 60) + ' h ' + n % 60 + ' min' : n + ' min';
}
function searchMessage(data, busy) {
    if (data.status === 'error') {
        if (data.error === 'BMW_CHARGER_CATEGORY') return 'BMW no ha facilitado la categoría de cargadores';
        if (/INVALID_POSITION|BAD_LOCATION/.test(data.error)) return 'BMW no dispone de una posición válida para buscar';
        if (data.error === 'BMW_SEARCH_TIMEOUT') return 'BMW no ha enviado resultados. Puedes reintentar.';
        if (data.error === 'BMW_LIST_NOT_RECEIVED') return 'BMW encontró lugares, pero no se recibió la lista';
        if (data.error === 'BMW_LIST_DESTROYED') return 'BMW ha cerrado la lista. Vuelve a buscar.';
        return 'No se ha podido completar la búsqueda en BMW';
    }
    if (busy || data.status === 'loading') return ({ session: 'Conectando con la búsqueda de BMW…', location: 'Obteniendo la posición del coche…',
        categories: 'Consultando las categorías de BMW…', view: 'Abriendo la lista de resultados…', results: 'Esperando los resultados de BMW…' })[data.searchPhase] || 'Buscando en BMW Maps…';
    return data.status === 'results' ? 'BMW ha terminado sin encontrar resultados' : 'Escribe un destino o busca cargadores';
}
function controls(cv, ui, nav) {
    const s = ui.state, data = s.controls || {}, p = palettes[s.theme === 'auto' ? nav.theme === 'day' ? 'day' : 'night' : s.theme];
    const busy = s.pending || data.busy, b = layout.panel(s), x = b.x, y = b.y, w = b.w, h = b.h;
    s.buttons = [];
    function text(value, xx, yy, size, color, max, bold) {
        let label = String(value || ''); const opts = bold ? { font: 'bold' } : {};
        if (max) while (label.length > 1 && cv.textWidth(label, size, opts) > max) label = label.replace(/…$/, '').slice(0, -1) + '…';
        cv.text(label, xx, yy, size, color || p.text, opts);
    }
    function wrap(value, xx, yy, width, size, color, lines) {
        const words = String(value || '').split(' '); let line = '', n = 0;
        while (words.length && n < (lines || 3)) {
            const next = words[0];
            if (line && cv.textWidth(line + ' ' + next, size) > width) { text(line, xx, yy + n++ * (size + 7), size, color, width); line = ''; }
            else { line += (line ? ' ' : '') + words.shift(); }
        }
        if (line) text(line + (words.length ? '…' : ''), xx, yy + n * (size + 7), size, color, width);
    }
    function button(id, label, xx, yy, ww, hh, opts) {
        opts = opts || {};
        s.buttons.push({ id, x: xx, y: yy, w: ww, h: hh, disabled: !!opts.disabled });
        const surface = opts.circle ? (p === palettes.day ? '#FFFFFF' : p.control) : opts.card ? p.card : opts.primary ? p.selected : opts.flat ? p.surface : p.control;
        if (opts.circle) cv.circle(xx + ww / 2 + 1, yy + hh / 2 + 2, hh / 2, p.line);
        cv.roundRect(xx, yy, ww, hh, opts.circle ? hh / 2 : 10, surface);
        if (opts.card) cv.strokeRoundRect(xx, yy, ww, hh, 10, 1, p.line);
        if (s.focus === id) cv.strokeRoundRect(xx, yy, ww, hh, opts.circle ? hh / 2 : 10, 3, p.accent);
        const ink = opts.disabled ? p.secondary : opts.primary ? p.primaryText : p.text;
        if (opts.icon) icon(cv, opts.icon, xx + ww / 2, yy + hh / 2, ink, surface, opts.scale || 1);
        else {
            const size = opts.size || 20;
            let name = String(label); while (cv.textWidth(name, size) > ww - 16 && name.length > 1) name = name.replace(/…$/, '').slice(0, -1) + '…';
            cv.text(name, xx + ww / 2, yy + hh / 2 + size * .35, size, ink, { align: 'center' });
        }
    }
    function row(id, title, yy, glyph, sub, disabled) {
        button(id, '', x + 12, yy, w - 24, 54, { flat: true, disabled });
        if (glyph) icon(cv, glyph, x + 34, yy + 27, p.text, p.surface, .85);
        text(title, x + (glyph ? 60 : 20), yy + (sub ? 24 : 34), 20, p.text, w - 104);
        if (sub) text(sub, x + 60, yy + 45, 15, p.secondary, w - 104);
        icon(cv, 'next', x + w - 30, yy + 27, p.secondary, p.surface, .8);
    }
    function header(title) {
        const right = Math.min(x + w, preconditioningButton.x - 10);
        cv.roundRect(x, y, w, h, 13, p.surface);
        button('back', '', x + 10, y + 8, 46, 46, { icon: 'back' });
        text(title, x + 68, y + 39, 22, p.text, right - x - 130, true);
        button('close', '', right - 56, y + 8, 46, 46, { icon: 'close' });
    }
    function paging(length, count) {
        s.offset = Math.max(0, Math.min(s.offset, Math.max(0, length - count)));
        if (length > count) {
            const top = y + 70, track = h - 132, thumb = Math.max(28, track * count / length);
            cv.roundRect(x + w - 10, top, 4, track, 2, p.line);
            cv.roundRect(x + w - 10, top + (track - thumb) * s.offset / (length - count), 4, thumb, 2, p.accent);
        }
        text(length ? (s.offset + 1) + '–' + Math.min(length, s.offset + count) + ' de ' + length : '', x + 18, y + h - 20, 16, p.secondary);
        if (length > count) {
            button('page-up', '', x + w - 110, y + h - 49, 44, 44, { icon: 'page-up', disabled: !s.offset });
            button('page-down', '', x + w - 60, y + h - 49, 44, 44, { icon: 'page-down', disabled: s.offset + count >= length });
        }
    }
    function list() {
        const chargers = s.searchKind === 'chargers', results = data.results || [], count = layout.pageSize(s);
        paging(results.length, count);
        if (!results.length) {
            icon(cv, chargers ? 'chargers' : 'search', x + w / 2, y + 133, p.secondary, p.surface, 1.4);
            wrap(searchMessage(data, busy), x + 28, y + 190, w - 56, 21, p.secondary);
            if (!busy) button(chargers ? 'chargers' : 'submit', data.status === 'error' ? 'Reintentar' : 'Buscar de nuevo', x + 56, y + 300, w - 112, 52, { primary: true });
            return;
        }
        results.slice(s.offset, s.offset + count).forEach((item, i) => {
            const yy = y + 68 + i * (chargers ? 156 : 78), hh = chargers ? 146 : 70;
            button('result:' + item.id, '', x + 12, yy, w - 32, hh, { card: true, disabled: busy });
            cv.circle(x + 34, yy + 26, 13, p.selected);
            cv.text(String(s.offset + i + 1), x + 34, yy + 32, 18, p.primaryText, { align: 'center' });
            text(item.name, x + 57, yy + 32, 21, p.text, w - 104, true);
            icon(cv, 'next', x + w - 38, yy + 28, p.secondary, p.surface, .8);
            text(distance(item.metres) + ' · línea recta', x + 24, yy + 62, 17, p.secondary, w - 62);
            if (chargers) {
                text('Llegada: — %', x + 24, yy + 86, 17, p.secondary);
                icon(cv, 'battery', x + w - 56, yy + 79, p.secondary, p.surface, .75);
                text('Potencia máx.: — kW', x + 24, yy + 111, 19, p.text);
                cv.line(x + 24, yy + 120, x + w - 38, yy + 120, 1, p.line);
                [['check', 'Disp. —', p.good], ['clock', 'Ocup. —', p.warn], ['close', 'Aver. —', p.danger]].forEach((a, k) => {
                    icon(cv, a[0], x + 31 + k * 124, yy + 135, a[2], p.surface, .65);
                    text(a[1], x + 46 + k * 124, yy + 140, 15, a[2]);
                });
            }
        });
    }
    function keyboard() {
        button('query', '', x + 12, y + 70, w - 138, 50);
        let first = 0;
        while (first < s.cursor && cv.textWidth(s.query.slice(first, s.cursor), 20) > w - 190) first++;
        text(s.query.slice(first) || 'Dirección, ciudad o lugar', x + 26, y + 103, 20, s.query ? p.text : p.secondary, w - 172);
        const caret = x + 26 + cv.textWidth(s.query.slice(first, s.cursor), 20);
        cv.line(caret, y + 82, caret, y + 108, 2, p.accent);
        button('submit', 'Buscar', x + w - 116, y + 70, 104, 50, { primary: true, disabled: busy || !s.query.trim() });
        const rows = s.keyboardNumbers ? ['1234567890', '-/.,:;()@&', 'ÁÉÍÓÚÜÑ?!'] : ['QWERTYUIOP', 'ASDFGHJKLÑ', 'ZXCVBNM'];
        rows.forEach((letters, r) => {
            const start = x + (w - (letters.length * 69 - 7)) / 2;
            letters.split('').forEach((key, i) => button('key:' + key, key, start + i * 69, y + 138 + r * 58, 62, 50));
        });
        button('numbers', s.keyboardNumbers ? 'ABC' : '123', x + 18, y + 318, 70, 50);
        button('clear', 'Vaciar', x + 96, y + 318, 76, 50, { size: 18 });
        button('cursor-left', '', x + 180, y + 318, 44, 50, { icon: 'back', scale: .8 });
        button('cursor-right', '', x + 232, y + 318, 44, 50, { icon: 'next', scale: .8 });
        button('key: ', 'Espacio', x + 284, y + 318, 250, 50);
        button('erase', 'Borrar', x + 542, y + 318, 84, 50, { size: 18 });
        button('keyboard-done', 'Listo', x + 634, y + 318, 92, 50);
    }
    function detail() {
        const selected = data.selected || {}, charger = selected.type === 'charger';
        text(charger ? 'Estación de carga' : 'Información del lugar', x + 20, y + 94, 18, p.secondary);
        wrap(selected.name, x + 20, y + 128, 450, 28, p.text, 2);
        const actionX = x + w - 234;
        button(s.addingStop ? 'add-stop' : 'route', s.addingStop ? 'Añadir a la ruta' : 'Cómo llegar', actionX, y + 76, 214, 54, { primary: true, disabled: busy || !selected.address });
        const saved = selected.address && s.favorites.some((f) => JSON.stringify(f.address) === JSON.stringify(selected.address));
        button('save-destination', saved ? 'Quitar de favoritos' : 'Guardar favorito', actionX, y + 140, 214, 50, { disabled: !selected.address, size: 19 });
        if (!s.addingStop) button('add-stop', 'Añadir parada', actionX, y + 200, 214, 50, { disabled: busy || !(data.stops || []).length });
        cv.line(x + 20, y + 184, actionX - 24, y + 184, 1, p.line);
        text('Información', x + 20, y + 218, 21, p.text, 440, true);
        if (selected.details && selected.details.length) selected.details.slice(0, 3).forEach((v, i) => text(v, x + 20, y + 248 + i * 26, 18, p.secondary, 450));
        else text('Sin información adicional de BMW', x + 20, y + 248, 18, p.secondary);
        if (selected.phone) text('Teléfono: ' + selected.phone, x + 20, y + 330, 19, p.text, 460);
        if (Number.isFinite(selected.latitude)) text(selected.latitude.toFixed(5) + ', ' + selected.longitude.toFixed(5), x + 20, y + 362, 17, p.secondary);
        if (charger) { text('Recarga', actionX, y + 300, 22, p.text, 214, true); text('Potencia: — kW', actionX, y + 332, 19, p.secondary); text('Disponibilidad: —', actionX, y + 362, 19, p.secondary); }
    }
    function route() {
        const stops = data.plan ? data.stops || [] : scene.stops(s), plan = data.plan || {}, last = stops[stops.length - 1];
        if (s.routePage === 'battery') {
            text('Batería mínima al llegar', x + 20, y + 102, 22, p.text, w - 40);
            cv.text(s.preferences.arrival + '%', x + w / 2, y + 190, 54, p.text, { align: 'center' });
            button('arrival-down', '−', x + 64, y + 220, 96, 52); button('arrival-up', '+', x + w - 160, y + 220, 96, 52);
            wrap('Objetivo para el cálculo de BMW. La previsión de llegada aún no está disponible.', x + 22, y + 307, w - 44, 18, p.secondary);
            button('recalculate', 'Aplicar', x + 20, y + h - 64, w - 40, 50, { primary: true, disabled: busy || !stops.length });
        } else if (s.routePage === 'stops') {
            const itinerary = [{ name: 'Ubicación actual', kind: 'origin' }].concat(stops.map((a, i) => Object.assign({}, a, { kind: i === stops.length - 1 ? 'destination' : a.charging ? 'charge' : 'number' })));
            paging(itinerary.length, 4);
            itinerary.slice(s.offset, s.offset + 4).forEach((a, i) => {
                const yy = y + 94 + i * 68;
                if (i < Math.min(3, itinerary.length - s.offset - 1)) cv.line(x + 32, yy + 9, x + 32, yy + 59, 2, p.line);
                if (a.kind === 'origin') { cv.circle(x + 32, yy, 8, p.accent); cv.circle(x + 32, yy, 4, p.surface); }
                else icon(cv, a.kind === 'charge' ? 'chargers' : 'destination', x + 32, yy, a.kind === 'destination' ? p.danger : p.text, p.surface, .75);
                text(a.name || 'Destino BMW', x + 56, yy + 5, 20, p.text, w - 82);
                text(a.kind === 'charge' ? 'Parada de carga · llegada — %' : a.kind === 'origin' ? 'Origen' : 'Llegada — %', x + 56, yy + 28, 16, p.secondary, w - 82);
            });
        } else {
            button('route-page:stops', '', x + 12, y + 72, w - 24, 80, { card: true });
            text(last && last.name || (busy ? 'Calculando ruta…' : 'Ruta de BMW Maps'), x + 24, y + 104, 25, p.text, w - 62, true);
            text(duration(plan.seconds) + ' · ' + distance(plan.metres), x + 24, y + 135, 21, p.eta, w - 62);
            icon(cv, 'next', x + w - 28, y + 112, p.secondary, p.surface, .8);
            row('route-page:stops', 'Información detallada', y + 162, 'info');
            row('route-page:battery', 'Batería al llegar: — %', y + 220, 'battery', 'Mínimo: ' + s.preferences.arrival + '%');
            const charges = stops.filter((a) => a.charging).length;
            row('route-page:stops', charges + (charges === 1 ? ' parada de carga' : ' paradas de carga'), y + 278, 'chargers');
            button('add-stop-search', 'Añadir parada', x + 14, y + h - 64, 160, 52, { disabled: busy || !stops.length });
            button('start', 'Iniciar', x + 184, y + h - 64, w - 198, 52, { primary: true, disabled: busy || !data.plan || data.status !== 'preview' });
        }
    }
    function settings() {
        [['charging', 'Añadir paradas de carga'], ['tolls', 'Utilizar peajes'], ['motorways', 'Utilizar autopistas']].forEach(([key, label], i) => {
            const yy = y + 76 + i * 58; text(label, x + 20, yy + 29, 20, p.text, w - 120);
            button('pref:' + key, s.preferences[key] ? 'Sí' : 'No', x + w - 92, yy, 72, 44, { primary: s.preferences[key] });
        });
        text('Mínimo al destino', x + 20, y + 277, 20, p.text);
        button('arrival-down', '−', x + 212, y + 250, 46, 44); text(s.preferences.arrival + '%', x + 270, y + 280, 20); button('arrival-up', '+', x + w - 66, y + 250, 46, 44);
        button('theme', 'Tema: ' + ({ auto: 'Automático', day: 'Día', night: 'Noche' })[s.theme], x + 20, y + 306, w - 40, 46);
        button('recalculate', 'Aplicar a esta ruta', x + 20, y + 364, w - 40, 50, { primary: true, disabled: busy || !(data.stops || []).length });
    }
    // Separate circles, in reference order; unavailable BMW features stay disabled.
    const ready = ui.tiles.status().ready;
    [['settings', 'settings'], ['audio', 'audio'], ['chargers', 'chargers'], ['recent', 'recent'], ['center', 'center'], ['assistant', 'assistant']].forEach((a, i) =>
        button(a[0], '', map.x + 12, map.y + 10 + i * 55, 50, 50, { circle: true, icon: a[1], disabled: a[0] === 'audio' || a[0] === 'assistant' && !ui.assistant || a[0] === 'center' && !ready }));
    button('zoom-in', '', map.x + 12, map.y + 350, 50, 44, { icon: 'zoom-in', disabled: !ready });
    button('zoom-out', '', map.x + 12, map.y + 398, 50, 44, { icon: 'zoom-out', disabled: !ready });
    if (s.panel === 'none') {
        button('search', 'Buscar destino o lugar', x, y, 440, 52);
        if (nav.state === 'active') {
            const turn = nav.instruction;
            if (turn) {
                const labels = { LEFT: 'Gira a la izquierda', RIGHT: 'Gira a la derecha', STRAIGHT_ON: 'Continúa recto', SLIGHT_LEFT: 'Mantente a la izquierda', SLIGHT_RIGHT: 'Mantente a la derecha' };
                cv.roundRect(x, y, 560, 88, 12, '#008A92');
                text(turn.kind === 'roundabout' ? 'Rotonda · salida ' + (turn.exit || '—') : labels[turn.direction] || 'Continúa por la ruta', x + 18, y + 34, 24, '#FFFFFF', 400, true);
                text(turn.road, x + 18, y + 65, 20, '#FFFFFF', 410);
                text(turn.metres == null ? '' : turn.metres < 1000 ? turn.metres + ' m' : distance(turn.metres), x + 438, y + 34, 22, '#FFFFFF', 110);
                s.buttons = s.buttons.filter((a) => a.id !== 'search');
            }
            const final = (nav.destinations || []).find((d) => d.final), yy = map.y + map.h - 140;
            cv.roundRect(x, yy, 440, 112, 12, p.surface);
            text(duration(final && final.seconds), x + 18, yy + 34, 29, p.eta, 400, true);
            text(distance(final && final.metres) + ' · llegada — %', x + 18, yy + 61, 18, p.secondary);
            [['stop', 'stop'], ['route-panel', 'route-panel'], ['search', 'zoom-in'], ['fit', 'fit'], ['settings', 'settings']].forEach((a, i) =>
                button(a[0], '', x + 12 + i * 84, yy + 68, 78, 40, { flat: true, icon: a[1], disabled: a[0] === 'fit' && !ready }));
        }
    } else {
        const titles = { search: s.keyboard ? 'Buscar' : s.searchKind === 'chargers' ? 'Estaciones de carga' : s.query || 'Resultados', detail: 'Información del lugar', route: s.routePage === 'stops' ? 'Detalles de la ruta' : s.routePage === 'battery' ? 'Batería al llegar' : 'Navegación', settings: 'Ajustes de navegación', recent: 'Destinos guardados', stop: 'Finalizar navegación' };
        Object.assign(titles, { settings: 'Ajustes', 'route-settings': 'Ajustes de navegación', assistant: 'Asistente', 'assistant-settings': 'Configurar asistente', 'assistant-edit': 'Asistente', 'assistant-voices': 'Voces del asistente' });
        titles['guidance-displays'] = 'HUD y cuadro · navegación BMW';
        header(titles[s.panel] || 'Navegación');
        if (s.panel === 'search') { if (s.keyboard) keyboard(); else list(); }
        else if (s.panel === 'detail') detail();
        else if (s.panel === 'route') route();
        else if (s.panel === 'settings') {
            row('route-settings', 'Navegación', y + 86, 'route-panel', 'Ruta, recargas y aspecto');
            row('assistant:settings', 'Asistente', y + 162, 'assistant', 'Proveedor, voz y API key', !ui.assistant);
            row('guidance-displays', 'HUD y cuadro', y + 238, 'route-panel', 'Maniobras y vistas originales BMW');
        }
        else if (s.panel === 'route-settings') settings();
        else if (s.panel === 'guidance-displays') displayPanel.draw({ ui, x, y, w, p, text, wrap, button });
        else if (s.panel.indexOf('assistant') === 0 && ui.assistant) assistantPanel.draw({ ui, x, y, w, p, text, wrap, button });
        else if (s.panel === 'recent') {
            const favorites = s.savedTab === 'favorites', entries = favorites ? s.favorites : s.recent;
            button('saved-recent', 'Recientes', x + 12, y + 68, 192, 46, { primary: !favorites });
            button('saved-favorites', 'Favoritos', x + 212, y + 68, 196, 46, { primary: favorites });
            paging(entries.length, 4);
            entries.slice(s.offset, s.offset + 4).forEach((a, i) => button((favorites ? 'favorite:' : 'history:') + (s.offset + i), favorites ? a.name : a, x + 12, y + 126 + i * 58, w - 32, 50));
            if (!entries.length) wrap(favorites ? 'Guarda un destino desde su ficha.' : 'Aquí aparecerán tus búsquedas recientes.', x + 24, y + 170, w - 48, 21, p.secondary);
        } else if (s.panel === 'stop') {
            wrap('¿Finalizar el guiado de BMW Maps?', x + 24, y + 132, w - 48, 25, p.text);
            button('confirm-stop', 'Finalizar ruta', x + 24, y + 232, w - 48, 54, { primary: true, disabled: busy });
            button('back', 'Continuar', x + 24, y + 298, w - 48, 54);
        }
    }
    cv.fillRect(map.x + 74, map.y + map.h - 24, map.w - 148, 24, p.surface);
    text(s.message || (data.status === 'error' && s.panel !== 'search' ? 'BMW: ' + data.error : ready ? 'Navegación BMW' : 'Navegación BMW · mapa local no disponible'), map.x + 86, map.y + map.h - 7, 14, p.secondary, map.w - 170);
    return p;
}
module.exports = { controls, palettes, shorten, searchMessage, distance, duration };
