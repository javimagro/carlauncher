'use strict';

const { cards, viewport, dailyChart } = require('./drivehub-state.js');

const map = { x: 4, y: 4, w: viewport.x - 12, h: 512 };
const energyBar = { x: viewport.x, y: 476, w: viewport.w, h: 40 };
const background = '#080b0e';
const primary = '#f2f7fb';
const secondary = '#a9b8c7';
const amber = '#ffa327';
const turquoise = '#36d5ca';
const centered = { align: 'center' };
const right = { align: 'right' };
const bold = { font: 'bold' };
const number = (value, decimals = 0) => Number.isFinite(value)
    ? String(Number(value.toFixed(decimals))).replace('.', ',') : '–';
const temperature = (value) => number(value) + '°';
const clock = (value) => value || '–';

function fit(cv, text, x, y, size, max, color, opts) {
    let value = String(text);
    if (cv.textWidth(value, size, opts) > max) {
        while (value.length && cv.textWidth(value + '…', size, opts) > max) value = value.slice(0, -1);
        value += '…';
    }
    cv.text(value, x, y, size, color, opts);
}

function wrap(cv, text, size, lineWidth, opts) {
    const result = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
        const candidate = line ? line + ' ' + word : word;
        if (line && cv.textWidth(candidate, size, opts) > lineWidth(result.length)) {
            result.push(line);
            line = word;
        } else line = candidate;
    }
    if (line) result.push(line);
    return result;
}

function wallpaper(cv, x, w, y, h, focused, overPhoto) {
    const origin = viewport.x;
    const scale = viewport.w / 100;
    if (!overPhoto) cv.fillRect(x, y, w, h, '#0a1018');
    const light = overPhoto ? [101, 151, 183, 45] : focused ? '#334f63' : '#172535';
    const dark = '#101a26';
    for (const [a, b, strong] of [[-40, -10, true], [0, 10, false], [20, 55, true],
        [60, 65, false], [70, 95, true], [100, 110, false], [120, 150, true]]) {
        if (overPhoto && !strong) continue;
        cv.quad([[origin + a * scale, y], [origin + b * scale, y],
            [origin + (b + 50) * scale, y + h], [origin + (a + 50) * scale, y + h]], strong ? light : dark);
    }
}

function trip(cv, x, y, w, h) {
    const metrics = [
        ['Consumo medio', '25,3 kWh/100 km'], ['Consumo medio total', '21,9 kWh/100 km'],
        ['Distancia recorrida', '50,9 km'], ['Velocidad media', '76 km/h'],
        ['Energía consumida', '12,9 kWh'], ['Duración', '2 h 15 m']
    ];
    const col = (w - 65) / 2;
    metrics.forEach(([label, value], index) => {
        const left = x + 29 + (index % 2) * (col + 5);
        const top = y + 53 + Math.floor(index / 2) * 74;
        cv.roundRect(left, top, col, 69, 9, [21, 38, 52, 130]);
        cv.strokeRoundRect(left, top, col, 69, 9, 1, [117, 155, 178, 55]);
        cv.text(label, left + col / 2, top + 24, 16, secondary, centered);
        cv.text(value, left + col / 2, top + 55, 21, primary, centered);
    });
    const left = x + 29;
    cv.roundRect(left, y + 277, w - 60, 105, 9, [21, 38, 52, 142]);
    cv.strokeRoundRect(left, y + 277, w - 60, 105, 9, 1, [117, 155, 178, 55]);
    cv.text('Altura', x + w / 2, y + 299, 16, secondary, centered);
    cv.text('917 m', x + w - 39, y + 299, 21, primary, right);
    cv.gradientRect(left + 8, y + 337, w - 76, 41, [[0, [61, 196, 232, 90]], [1, [61, 196, 232, 0]]]);
    cv.line(left + 8, y + 337, x + w - 39, y + 338, 2, '#52d9f8');
    for (const [index, label, value] of [[0, 'Exterior', '–'], [1, 'Batería HV', '17 °C']]) {
        const center = left + col * (index + 0.5) + index * 5;
        cv.text(label, center, y + h - 60, 13, primary, centered);
        cv.text(value, center, y + h - 41, 15, primary, centered);
        const colors = ['#64bfe7', '#3ad674', '#ffce43', '#ff515d'];
        cv.rampRect(center - 69, y + h - 26, 138, 8, 4, [
            colors[0], colors[0], colors[1], colors[1], colors[2], colors[3], colors[3]
        ]);
        if (index) {
            cv.circle(center - 36, y + h - 22, 6, '#0a141e');
            cv.circle(center - 36, y + h - 22, 4, primary);
        }
    }
}

function radio(cv, x, y, w, h, art) {
    const left = x + 26;
    cv.text('Onda Cero', left, y + 70, 22, amber);
    cv.text('Por fin', left, y + 100, 16, primary);
    cv.text('15:00', left, y + 127, 13, primary);
    cv.text('19:00', x + w - 26, y + 127, 13, primary, right);
    cv.roundRect(left + 45, y + 121, w - 144, 4, 2, '#1a2b3c');
    cv.fillRect(left + 45, y + 119, 12, 8, turquoise);
    cv.line(left, y + 142, x + w - 26, y + 142, 1, '#364957');
    cv.image(art('radio'), x + (w - 120) / 2, y + 209, 120, 120, 10);
    for (let i = 0; i < 56; i++) {
        const amplitude = 4 + 26 * Math.abs(Math.sin(i * 1.77) * Math.cos(i * 0.24));
        const at = x + 53 + i * (w - 106) / 55;
        cv.line(at, y + h - 39 - amplitude, at, y + h - 39 + amplitude, 1.2, turquoise);
    }
}

function smallWeatherIcon(cv, x, y, kind) {
    const cloud = '#a9b8c7';
    if (kind === 'sunny' || kind === 'night') {
        cv.circle(x, y, 12, kind === 'sunny' ? '#ffc65b' : '#c7d9e8');
        if (kind === 'night') cv.circle(x + 6, y - 4, 10, '#152131');
        return;
    }
    cv.circle(x - 12, y + 3, 7, cloud);
    cv.circle(x, y - 3, 12, cloud);
    cv.circle(x + 12, y + 3, 7, cloud);
    cv.roundRect(x - 17, y + 1, 34, 9, 5, cloud);
    if (['rain', 'storm', 'snow'].includes(kind)) {
        for (let n = -1; n <= 1; n++) cv.line(x + n * 8, y + 13, x + n * 8 - 2, y + 22, 2.6,
            kind === 'snow' ? primary : '#54acff');
    }
}

function sunTime(cv, x, y, time, rise) {
    cv.arc(x + 10, y - 4, 0, 5, 180, 360, '#ffb53d');
    cv.line(x, y - 2, x + 20, y - 2, 2, primary);
    cv.polyline([[x + 7, y - (rise ? 15 : 20)], [x + 10, y - (rise ? 20 : 15)],
        [x + 13, y - (rise ? 15 : 20)]], 2, primary);
    cv.text(clock(time), x + 28, y - 2, 16, primary);
}

function weatherSummary(cv, x, y, w, h, data, art) {
    cv.image(art('icon-' + data.kind), x + 14, y + 58, 52, 52);
    cv.text(temperature(data.temp), x + 78, y + 99, 52, primary);
    cv.text('Sensación ' + temperature(data.feels), x + 24, y + 132, 16, primary);
    cv.text('Máx. ' + temperature(data.high) + ' · Mín. ' + temperature(data.low), x + 24, y + 155, 13, primary);
    const metrics = x + w * 0.63;
    cv.text('Precipitación', metrics, y + 61, 10, primary);
    cv.text(number(data.probability) + '% · ' + number(data.rain, 1) + ' mm', metrics, y + 83, 15, primary);
    cv.text('Viento', metrics, y + 124, 10, primary);
    cv.text(number(data.wind) + ' km/h · ' + number(data.direction) + '°', metrics, y + 146, 15, primary);
    const span = (w * 0.60) / 3;
    const start = x + w * 0.37;
    const center = y + h * 0.58;
    data.hours.forEach((hour, index) => {
        const at = start + (index + 0.5) * span;
        if (index) cv.line(at - span / 2, center - 50, at - span / 2, center + 43, 1, [211, 225, 235, 120]);
        cv.text(hour.time, at, center - 30, 16, secondary, centered);
        smallWeatherIcon(cv, at, center - 3, hour.kind);
        cv.text(temperature(hour.temp) + ' · ' + number(hour.probability) + '%', at, center + 38, 15, primary, centered);
    });
    sunTime(cv, x + 13, y + h - 10, data.sunrise, true);
    sunTime(cv, x + 95, y + h - 10, data.sunset, false);
}

function rainChart(cv, x, y, w, h, series, hourly, selected = -1) {
    const left = x + 19;
    const bottom = y + h - 15;
    const usable = w - 21;
    const max = Math.max(1, Math.ceil(Math.max(...series.map((item) => item.mm || 0))));
    cv.text('mm', x, y - 5, 8, secondary);
    for (const fraction of [0, 0.5, 1]) {
        const at = bottom - (bottom - y) * fraction;
        cv.line(left, at, left + usable, at, 0.8, '#405468');
        cv.text(number(max * fraction, 1), x, at + 3, 8, secondary);
    }
    const step = usable / Math.max(1, series.length);
    series.forEach((item, index) => {
        const at = left + step * (index + 0.5);
        const rise = (item.mm || 0) / max * (bottom - y);
        if (rise > 0) {
            cv.gradientRect(at - step * 0.26, bottom - rise, step * 0.52, rise,
                [[0, index === selected ? '#8ef4ff' : '#37d6ec'], [1, '#17627e']]);
            if (!hourly || rise >= 6) cv.text(number(item.mm, 1), at, bottom - rise - 3, 8, primary, centered);
        }
        if (!hourly || index % 3 === 0) cv.text(item.label, at, bottom + 11, 8,
            index === selected ? primary : secondary, centered);
    });
}

function weatherRain(cv, x, y, w, h, data, selected, art) {
    const day = data.dailyRain[selected] || data.dailyRain[0];
    cv.fillRect(x + 10, y + 46, w - 20, h - 54, [9, 22, 35, 240]);
    cv.image(art('icon-rain-detail'), x + 16, y + 55, 29, 29);
    cv.text('Precipitación prevista', x + 53, y + 76, 16, primary);
    cv.text((selected && day ? day.label + ' ' + day.date : 'Hoy') + ' · por horas', x + 17, y + 101, 12, primary);
    rainChart(cv, x + 17, y + 121, w - 36, 131, day ? day.hours : [], true);
    cv.text('Próximos 7 días', x + 17, y + 270, 12, primary);
    rainChart(cv, x + dailyChart.x - 19, y + 291, dailyChart.w + 21, 143, data.dailyRain, false, selected);
    cv.text('Desliza arriba o abajo para volver al resumen', x + 17, y + h - 14, 9, secondary);
}

function timeAgo(date, now) {
    const minutes = Math.max(0, Math.floor((now - date) / 60000));
    if (minutes < 1) return 'Ahora';
    if (minutes < 60) return 'Hace ' + minutes + ' min';
    if (minutes < 1440) return 'Hace ' + Math.floor(minutes / 60) + ' h';
    return 'Hace ' + Math.floor(minutes / 1440) + ' d';
}

function news(cv, x, y, w, h, data, index, art, now) {
    const items = data.news || [];
    const item = items[index];
    if (!item) return empty(cv, x, y, w, h, data.newsStatus, 'Cargando noticias…', 'Noticias no disponibles', data.newsDetail);
    cv.rampRect(x + 13, y + 47, w - 26, h - 61, 16,
        [[23, 42, 58, 230], [11, 23, 34, 224], [3, 7, 11, 217]]);
    const left = x + 30;
    const photoX = x + w * 0.60;
    const photoTop = y + 64;
    const photoWidth = x + w - 30 - photoX;
    const photoHeight = Math.round(photoWidth * 9 / 16);
    cv.roundRect(photoX, photoTop, photoWidth, photoHeight, 12, '#101b26');
    cv.image(data.photo || art('news'), photoX, photoTop, photoWidth, photoHeight, 12);
    const source = [item.source, item.date ? timeAgo(item.date, now) : ''].filter(Boolean).join(' · ');
    fit(cv, source, left, y + 78, 13, photoX - left - 89, amber);
    cv.text((index + 1) + ' / ' + items.length, photoX - 17, y + 78, 13, primary, right);
    const column = photoX - left - 18;
    const headings = wrap(cv, item.title, 25, () => column);
    headings.slice(0, 3).forEach((line, row) => fit(cv,
        row === 2 && headings.length > 3 ? line + '…' : line, left, y + 111 + row * 28, 25, column, primary));
    const summaryStart = y + 111 + Math.min(3, headings.length) * 28;
    const summaryWidth = (row) => summaryStart + row * 19 - 14 < photoTop + photoHeight ? column : w - 60;
    const lines = wrap(cv, item.summary, 15, summaryWidth);
    const max = Math.min(lines.length, Math.floor((y + h - 29 - summaryStart) / 19) + 1);
    lines.slice(0, max).forEach((line, row) => fit(cv, row === max - 1 && max < lines.length ? line + '…' : line,
        left, summaryStart + row * 19, 15, summaryWidth(row), '#e6edf3'));
}

function empty(cv, x, y, w, h, status, loading, offline, detail) {
    cv.text(status === 'offline' ? offline : loading, x + w / 2, y + h / 2, 17, primary, centered);
    if (status === 'offline' && detail) fit(cv, detail, x + w / 2, y + h / 2 + 24, 13, w - 36, secondary, centered);
}

function drawCard(cv, card, x, selected, data, state, art, now) {
    const { y, h } = viewport;
    const w = card.w;
    const clipLeft = Math.max(x, viewport.x);
    const clipRight = Math.min(x + w, viewport.x + viewport.w);
    if (clipRight <= clipLeft) return;
    cv.clip(clipLeft, y, clipRight - clipLeft, h);
    wallpaper(cv, x, w, y, h, selected, false);
    if (card.id === 'weather' && data.weather) {
        cv.image(art('weather-' + data.weather.kind), x, y, w, h, 10);
        cv.rampRect(x, y, w, h, 10, [[9, 17, 28, 179], [9, 17, 28, 92]]);
        if (selected) wallpaper(cv, x, w, y, h, true, true);
    }
    cv.strokeRoundRect(x + 1, y + 1, w - 2, h - 2, 9, 1.6, selected ? '#7793a8' : '#3e4b56');
    cv.gradientRect(x + 1, y + 12, 2, h - 24, [[0, [122, 169, 203, 36]], [0.56, '#cfe9fa'], [1, [122, 169, 203, 10]]]);
    cv.gradientRect(x + w - 3, y + 12, 2, h - 24, [[0, [122, 169, 203, 36]], [0.56, '#cfe9fa'], [1, [122, 169, 203, 10]]]);
    const title = card.id === 'weather' ? card.title + ' - ' + (data.weather ? data.weather.name : data.city) : card.title;
    fit(cv, title, x + w / 2, y + 25, 19, w - 35, primary, { align: 'center', spacing: 2 });
    cv.rampRect(x + 8, y + 35, w - 16, 2, 0, ['#17383e', '#239696', '#17383e']);

    if (card.id === 'trip') trip(cv, x, y, w, h);
    if (card.id === 'radio') radio(cv, x, y, w, h, art);
    if (card.id === 'weather') {
        if (!data.weather) empty(cv, x, y, w, h, data.weatherStatus, 'Cargando el tiempo…',
            'El tiempo no está disponible', data.weatherDetail);
        else if (state.weatherPage === 'rain') weatherRain(cv, x, y, w, h, data.weather, state.weatherDay, art);
        else weatherSummary(cv, x, y, w, h, data.weather, art);
    }
    if (card.id === 'news') news(cv, x, y, w, h, data, state.article, art, now);
    const freshness = data[card.id + 'Status'];
    if (freshness === 'offline' && data[card.id]) cv.text('Sin conexión', x + w - 9, y + h - 6, 9, primary, right);
    cv.noclip();
}

function energy(cv, readings, art) {
    const { x, y, w, h } = energyBar;
    cv.roundRect(x, y, w, h, 8, '#05080b');
    const column = (w - 100) / readings.length;
    readings.forEach(({ label, soc, range }, index) => {
        const left = x + index * column + 9;
        if (index) cv.line(left - 9, y + 5, left - 9, y + h - 5, 1, '#33434e');
        cv.text(label, left, y + 12, 10, secondary);
        const band = soc < 20 ? 'low' : soc < 70 ? 'mid' : 'high';
        cv.image(art('battery-' + band), left - 3, y + 17, 35, 19);
        cv.text(soc + '%', left + 34, y + 34, 19, primary, bold);
        cv.image(art('range'), left + 81, y + 17, 18, 18);
        cv.text(range + ' km', left + 102, y + 34, 18, primary, bold);
    });
    cv.text('Demostración', x + w - 13, y + 24, 10, secondary, right);
}

function drawHome(cv, state, scroll, data, art, now) {
    cv.clear(background);
    cv.roundRect(map.x, map.y, map.w, map.h, 10, '#121c25');
    cv.strokeRoundRect(map.x + 1, map.y + 1, map.w - 2, map.h - 2, 10, 1, '#263641');
    cv.text('Mapa', map.x + map.w / 2, map.y + map.h / 2 + 7, 20, secondary, centered);
    cards.forEach((card, index) => drawCard(cv, card, viewport.x + card.x - scroll,
        state.selected === index, data, state, art, now));
    energy(cv, data.energy, art);
}

module.exports = { drawHome };
