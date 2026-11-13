'use strict';

const { filters } = require('./radio-ui');
const white = '#f2f7fb', muted = '#a9b8c7', accent = '#3ed8c2', gold = '#ffa327';
const center = { align: 'center' };
function fit(cv, value, x, y, size, width, color, align) {
    let s = String(value || '');
    while (s.length && cv.textWidth(s, size, align) > width) s = s.slice(0, -2) + '…';
    cv.text(s, x, y, size, color, align);
}
function icon(cv, type, x, y, color) {
    const line = (p) => cv.polyline(p.map((v) => [x + v[0], y + v[1]]), 2.5, color);
    if (type === 'favorites') {
        line([[0, 9], [-11, -1], [-11, -7], [-7, -10], [-2, -10], [0, -6], [2, -10], [7, -10], [11, -7], [11, -1], [0, 9]]);
    } else if (type === 'popular') {
        const p = []; for (let i = 0; i <= 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, r = i % 2 ? 5 : 12; p.push([Math.cos(a) * r, Math.sin(a) * r]); } line(p);
    } else if (type === 'music') {
        line([[-5, 6], [-5, -9], [9, -12], [9, 3]]); cv.circle(x - 8, y + 7, 4, color); cv.circle(x + 6, y + 4, 4, color);
    } else if (type === 'sports') {
        cv.circle(x, y, 11, color); cv.circle(x, y, 8.5, '#193748'); line([[0, -5], [5, -1], [3, 5], [-3, 5], [-5, -1], [0, -5]]);
    } else {
        cv.roundRect(x - 17, y - 11, 34, 24, 3, '#284f63');
        cv.circle(x + 8, y + 1, 6, color); line([[-12, -4], [-3, -4]]); line([[-12, 1], [-3, 1]]); line([[-12, 6], [-3, 6]]); line([[-11, -12], [13, -22]]);
    }
}
function logo(cv, ui, s, x, y, size) {
    const image = s && ui.images.get(s.key);
    if (image) cv.image(image, x, y, size, size, 9);
    else {
        cv.roundRect(x, y, size, size, 9, '#183c50'); icon(cv, 'radio', x + size / 2, y + size / 2, muted);
        if (size >= 100) fit(cv, s && s.band || 'FM / DAB', x + size / 2, y + size - 16, 14, size - 10, white, center);
    }
}
function drawRadio(cv, x, y, w, h, ui, now) {
    if (!ui) {
        cv.text('Radio BMW', x + w / 2, y + h / 2 - 10, 22, white, center);
        cv.text('Esperando al sintonizador', x + w / 2, y + h / 2 + 20, 16, muted, center); return;
    }
    const state = ui.state, data = state.frame, current = data.current;
    if (state.mode === 'list') {
        const bw = (w - 47) / 4;
        filters.forEach((type, i) => {
            const left = x + 16 + i * (bw + 5), on = state.filters.includes(type);
            cv.roundRect(left, y + 48, bw, 52, 7, state.filterFocus === i ? '#3b7084' : '#21495c');
            if (on || state.filterFocus === i) cv.roundRect(left + 1, y + 49, bw - 2, 50, 6, on ? '#376c79' : '#315a70');
            icon(cv, type, left + bw / 2, y + 74, on ? gold : white);
        });
        const rows = ui.rows();
        rows.slice(state.top, state.top + 4).forEach((s, i) => {
            const at = y + 112 + i * 84, focused = state.filterFocus < 0 && state.index === state.top + i;
            cv.roundRect(x + 16, at, w - 32, 80, 8, focused ? '#51899b' : '#102331');
            cv.rampRect(x + 18, at + 2, w - 36, 76, 7, focused ? ['#1c5066', '#142e40'] : ['#162e40', '#0c1927']);
            if (focused) cv.line(x + 22, at + 77, x + w * .42, at + 77, 3, accent);
            logo(cv, ui, s, x + 28, at + 12, 54);
            fit(cv, s.name, x + 93, at + 28, 20, w - 159, ui.favorite(s) ? gold : white);
            fit(cv, s.title || s.artist || (s.frequency ? s.frequency.toFixed(1).replace('.', ',') + ' MHz' : s.band), x + 93, at + 52, 13, w - 159, muted);
            if (current && current.key === s.key && data.active) cv.circle(x + w - 45, at + 65, 3, accent);
            icon(cv, 'favorites', x + w - 45, at + 31, ui.favorite(s) ? gold : '#657c8d');
        });
        if (!rows.length) {
            fit(cv, data.loading ? 'Buscando emisoras BMW…' : state.filters.length ? 'No hay emisoras en este filtro' : 'No hay emisoras disponibles', x + w / 2, y + 230, 17, w - 36, white, center);
            fit(cv, data.listError || (state.filters.length ? 'Pulsa el filtro para quitarlo' : 'Pulsa Actualizar para consultar BMW'), x + w / 2, y + 256, 13, w - 36, muted, center);
        }
        fit(cv, state.message || (rows.length + ' emisoras · FM/DAB'), x + 18, y + h - 58, 12, w - 36, muted);
        cv.roundRect(x + 16, y + h - 47, (w - 40) / 2, 34, 6, '#21495c');
        cv.roundRect(x + 24 + (w - 40) / 2, y + h - 47, (w - 40) / 2, 34, 6, '#21495c');
        cv.text('Volver', x + w / 4, y + h - 24, 15, white, center);
        cv.text('Actualizar', x + 3 * w / 4, y + h - 24, 15, white, center);
        return;
    }
    fit(cv, current ? current.name : 'Radio BMW', x + 26, y + 70, 22, w - 52, current && ui.favorite(current) ? gold : white);
    const entry = current && data.stations.find((s) => s.key === current.key && s.programme), programme = entry && entry.programme;
    const elapsed = programme && Number.isFinite(data.clock) ? (data.clock - programme.start + 86400) % 86400 : null;
    const duration = programme && (programme.end - programme.start + 86400) % 86400;
    const epg = elapsed !== null && duration > 0 && elapsed <= duration;
    fit(cv, epg && programme.name || current && (current.title || current.text || current.artist) || 'Emisoras del coche', x + 26, y + 100, 16, w - 52, white);
    if (epg) {
        const time = (v) => String(Math.floor(v / 3600)).padStart(2, '0') + ':' + String(Math.floor(v / 60) % 60).padStart(2, '0');
        cv.text(time(programme.start), x + 26, y + 127, 13, white);
        cv.text(time(programme.end), x + w - 26, y + 127, 13, white, { align: 'right' });
        cv.roundRect(x + 80, y + 121, w - 160, 4, 2, '#1a2b3c');
        cv.fillRect(x + 80, y + 121, (w - 160) * elapsed / duration, 4, accent);
    } else fit(cv, current ? current.band + (current.frequency ? ' · ' + current.frequency.toFixed(1).replace('.', ',') + ' MHz' : '') : 'FM / DAB', x + 26, y + 127, 13, w - 52, muted);
    cv.line(x + 26, y + 142, x + w - 26, y + 142, 1, '#364957');
    logo(cv, ui, current, x + (w - 144) / 2, y + 193, 144);
    const status = data.busy ? 'Sintonizando…' : current && current.receptionLost ? 'Sin recepción' :
        !data.sourceKnown ? 'Esperando a BMW' : data.active ? 'Fuente de radio activa' : 'Toca el logo para escuchar';
    fit(cv, status, x + w / 2, y + 369, 14, w - 40, muted, center);
    const barWidth = (w - 64) / (64 * 3), gap = barWidth * 1.4, total = 64 * barWidth + 63 * gap;
    ui.levels.forEach((level, i) => {
        const size = level * 57;
        cv.roundRect(x + (w - total) / 2 + i * (barWidth + gap), y + h - 86 - size / 2, barWidth, Math.max(1.4, size), 1, accent);
    });
    cv.text('Emisoras', x + 26, y + h - 23, 15, white);
    icon(cv, 'favorites', x + w - 43, y + h - 28, current && ui.favorite(current) ? gold : muted);
    fit(cv, state.message || data.listError || '', x + w / 2, y + h - 53, 12, w - 38, muted, center);
}
module.exports = { drawRadio };
