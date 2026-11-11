'use strict';

const { cards, map, energyBar, viewport, dailyChart } = require('./drivehub-state.js');
const { layout: tdtLayout, visibleChannels } = require('./tdtworld.js');
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
const diagnosticRows = [
    ['Batería del cuadro', 'statusChargeOfBatteryHybrid', 'displayChargingConditionHighVoltageStorage'],
    ['Batería LSC', 'displayConditionHybrid', 'displayChargingconditionHighvoltageStorage'],
    ['Autonomía del cuadro', 'displayRangeElectricVehicle', 'displayRangeElectricVehicle'],
    ['Autonomía LSC · unidad · validez', 'dataRangeDisplay', 'dataRangeDisplayElectric',
        'unitRangeDisplay', 'fadeoutRangeDisplayElectric'],
    ['Consumo medio BC1 · BC2 · unidad', 'statusConsumptionAverageElectricVehicle',
        'consumptionAverageElectricVehicleBC1', 'consumptionAverageElectricVehicleBC2',
        'unitOfMeasurementConsumptionElectricVehicleBC'],
    ['Trayecto · distancia · duración', 'driveSegment', 'bcBeTripDistanceKm', 'bcBeDurationDrive'],
    ['Trayecto · consumo · velocidad media', 'driveSegment', 'bcBeConsElectricVisible', 'bcBeSpeedAvgDrive'],
    ['Altura GPS · válida · fijación', 'rawPositionData', 'position.height.rawLengthMeter', 'position.heightValid', 'fixType'],
    ['Temperatura batería HV', 'statusBatteryTemperature', 'actualValueTemperatureHighVoltageStorage'],
    ['Temperatura exterior', 'ExteriorTemperature', 'temperatureExterior'],
    ['Precalentamiento HV · VWM', 'statusPredictiveThermalManagement', 'preconditioningActive', 'statusVWM'],
    ['Potencia relativa de tracción', 'displayPowerDrive', 'quotaImmediateElectricEngineDriveRecuperation'],
    ['Energía disponible · máxima', 'highVoltageStorageInfoToExternal',
        'energyDischargeHighVoltageStoragePresentDynamic', 'energyDischargeHighVoltageStorageMaximalDynamic'],
    ['Estado térmico para carga rápida', 'statusHighVoltageBattery', 'thermalStatusHighVoltageBatteryForFastCharging'],
    ['Android Auto · vídeo', 'isVideoStreaming', 'value'],
    ['Velocidad del coche', 'statusCarSpeed2', 'speedVehicleCentreOfGravity']
];
const diagnosticEnums = {
    KILOMETER: 'km', MEILEN: 'mi',
    REICHWEITENINFORMATIONEN_EINBLENDEN: 'visible',
    VERBRAUCH_IN_KWH__S__100KM: 'kWh/100 km',
    VERBRAUCH_IN_WH__S__KM: 'Wh/km',
    NO_THERMAL_LIMITATIONS: 'Sin limitaciones',
    THERMAL_LIMITATIONS_COLD: 'Batería fría',
    THERMAL_LIMITATIONS_HOT: 'Batería caliente',
    CONDITIONAL_THERMAL_LIMITATIONS_COLD: 'Limitación por frío',
    CONDITIONAL_THERMAL_LIMITATIONS_HOT: 'Limitación por calor',
    SIGNAL_UNBEFUELLT: 'Sin dato'
};

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

function diagnosticValue(value) {
    if (Number.isFinite(value)) return number(value, 2);
    if (typeof value === 'boolean') return value ? 'Sí' : 'No';
    if (typeof value === 'string') return Object.prototype.hasOwnProperty.call(diagnosticEnums, value)
        ? diagnosticEnums[value] : value;
    return '–';
}

function diagnostics(cv, records) {
    const margin = 23;
    const gap = 5;
    const firstRow = 75;
    const rowCount = Math.ceil(diagnosticRows.length / 2);
    const rowHeight = Math.floor((map.h - firstRow - 12 + gap) / rowCount) - gap;
    const column = (map.w - 2 * margin - 10) / 2;
    cv.text('LECTURAS DEL COCHE', map.x + 24, map.y + 31, 22, primary, bold);
    cv.text('Valores de prueba para comparar con el cuadro', map.x + 24, map.y + 55, 14, secondary);
    diagnosticRows.forEach(([label, signal, ...keys], index) => {
        const x = map.x + margin + index % 2 * (column + 10);
        const y = map.y + firstRow + Math.floor(index / 2) * (rowHeight + gap);
        const record = records && records.get(signal);
        const fields = record && record.fields;
        let value = !records ? 'Esperando conexión…' : 'Sin muestra';
        let color = secondary;
        if (fields && record.status === 'sample') {
            value = keys.map((key) => diagnosticValue(fields[key])).join('  ·  ');
            color = primary;
        } else if (record && record.status === 'error') {
            const phases = { proxy: 'servicio', getter: 'lectura', subscribe: 'suscripción' };
            value = 'Error de ' + (phases[record.phase] || 'lectura');
            color = amber;
        }
        cv.roundRect(x, y, column, rowHeight, 5, '#192734');
        cv.text(label, x + 10, y + 16, 13, secondary);
        fit(cv, value, x + 10, y + rowHeight - 8, 17, column - 20, color);
    });
}

function trip(cv, x, y, w, h, preconditioning) {
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
    const altitudeTop = y + 277;
    const altitudeBottom = y + h - 86;
    const graphTop = y + 337;
    cv.roundRect(left, altitudeTop, w - 60, altitudeBottom - altitudeTop, 9, [21, 38, 52, 142]);
    cv.strokeRoundRect(left, altitudeTop, w - 60, altitudeBottom - altitudeTop, 9, 1, [117, 155, 178, 55]);
    cv.text('Altura', x + w / 2, y + 299, 16, secondary, centered);
    cv.text('917 m', x + w - 39, y + 299, 21, primary, right);
    cv.gradientRect(left + 8, graphTop, w - 76, altitudeBottom - graphTop - 4,
        [[0, [61, 196, 232, 90]], [1, [61, 196, 232, 0]]]);
    cv.line(left + 8, graphTop, x + w - 39, graphTop + 1, 2, '#52d9f8');
    const batteryLabel = typeof preconditioning === 'boolean'
        ? 'Precalentamiento ' + (preconditioning ? 'activo' : 'inactivo') : 'Batería HV';
    for (const [index, label, value] of [[0, 'Exterior', '–'], [1, batteryLabel, '17 °C']]) {
        const center = left + col * (index + 0.5) + index * 5;
        cv.text(label, center, y + h - 60, 13, index && preconditioning ? amber : primary, centered);
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
    rainChart(cv, x + dailyChart.x - 19, y + dailyChart.y + 10,
        dailyChart.w + 21, dailyChart.h - 10, data.dailyRain, false, selected);
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

function programmeTimes(tdt, item) {
    if (!item) return ['–', '–'];
    return item.startLabel ? [item.startLabel, item.endLabel] : [tdt.time(item.start), tdt.time(item.end)];
}

function tdtworld(cv, x, y, w, h, tdt, focused, clipLeft, clipRight, now) {
    const l = tdtLayout(w, h);
    const { state } = tdt;
    const left = x + 9;
    const top = y + l.top;
    const detailX = x + l.detailX;
    const detailRight = detailX + l.detailWidth;
    const item = tdt.selected();
    const programme = tdt.program(item, now, true);
    const action = state.mode === 'browse' ? 'Menú' : 'Volver';
    cv.roundRect(x + l.actionX, y + 7, 92, 23, 5, '#173043');
    cv.text(action, x + l.actionX + 46, y + 23, 13, primary, centered);
    if (state.mode === 'player') {
        cv.roundRect(left, y + 7, 96, 23, 5, '#173043');
        cv.text('Canales', left + 48, y + 23, 13, primary, centered);
    } else if (state.status === 'cached') cv.text('Catálogo sin conexión', left, y + 23, 13, secondary);
    cv.fillRect(left, top, w - 18, l.body, '#07111e');

    if (['menu', 'settings', 'filters'].includes(state.mode)) {
        const rows = {
            menu: () => tdt.menu().map((label) => ({ label })), settings: tdt.settings, filters: tdt.filters
        }[state.mode]();
        rows.forEach(({ label, value }, index) => {
            const row = y + l.menuTop + index * l.menuRow;
            cv.roundRect(x + l.menuX, row, w - 2 * l.menuX, l.menuRow - 5, 6,
                state.option === index ? '#183751' : '#0e1b2a');
            cv.text(label, x + l.menuX + 14, row + 29, 18, primary);
            if (value) cv.text(value + '  ›', x + w - l.menuX - 14, row + 29, 17, turquoise, right);
        });
        return;
    }
    if (state.mode === 'player') {
        const surface = tdt.video();
        if (surface && surface.image) {
            const width = Math.min(w - 18, l.body * surface.image.w / surface.image.h);
            const height = width * surface.image.h / surface.image.w;
            cv.image(surface.image, x + (w - width) / 2, top + (l.body - height) / 2, width, height);
        } else if (surface) cv.video(surface.id, left, top, w - 18, l.body);
        const message = {
            loading: 'Abriendo la emisión…', error: 'No se ha podido reproducir la emisión',
            unavailable: 'Reproductor no disponible en este equipo', 'no-source': 'Canal sin emisión directa compatible'
        }[state.playback];
        if (message) cv.text(message, x + w / 2, top + l.body / 2, 20, primary, centered);
        if (state.playback === 'playing' && state.audioStatus === 'audio-unavailable') {
            cv.roundRect(x + w - 156, top + 8, 138, 24, 5, [7, 17, 30, 220]);
            cv.text('Audio no disponible', x + w - 87, top + 24, 13, primary, centered);
        }
        if (state.overlayUntil > now) {
            cv.fillRect(left, top + l.body - 57, w - 18, 57, [7, 17, 30, 225]);
            fit(cv, item.name, left + 15, top + l.body - 31, 21, w - 50, primary, bold);
            if (programme) fit(cv, programme.title, left + 15, top + l.body - 11, 15, w - 50, secondary);
        }
        if (state.playerChoice !== undefined) {
            const first = tdt.playerStart();
            state.channels.slice(first, first + visibleChannels).forEach((channel, index) => {
                const at = top + index * l.rowHeight;
                cv.roundRect(left, at, l.listWidth, l.rowHeight - 4, 6,
                    first + index === state.playerChoice ? '#183751' : [7, 17, 30, 226]);
                fit(cv, channel.name, left + 12, at + 32, 18, l.listWidth - 24, primary);
            });
        }
        return;
    }

    if (state.mode === 'guide') {
        const rows = tdt.programs();
        const first = tdt.guideStart(now);
        rows.slice(first, first + visibleChannels).forEach((entry, index) => {
            const at = top + index * l.rowHeight;
            cv.roundRect(left, at, l.listWidth, l.rowHeight - 4, 6, entry === programme ? '#183751' : '#0e1b2a');
            fit(cv, entry.title, left + 9, at + 22, 16, l.listWidth - 18, primary);
            cv.text(programmeTimes(tdt, entry).join(' – '), left + 9, at + 43, 13, secondary);
        });
    } else {
        state.channels.slice(state.firstChannel, state.firstChannel + visibleChannels).forEach((channel, index) => {
            const at = top + index * l.rowHeight;
            const selected = index + state.firstChannel === state.channel && focused;
            const info = tdt.program(channel, now, false);
            const [start, end] = programmeTimes(tdt, info);
            const progress = info ? (info.progress === undefined
                ? Math.min(1, Math.max(0, (now - info.start) / (info.end - info.start))) : info.progress) : 0;
            cv.roundRect(left, at, l.listWidth, l.rowHeight - 4, 7, selected ? '#112940' : '#0e1b2a');
            if (selected) cv.strokeRoundRect(left, at, l.listWidth, l.rowHeight - 4, 7, 1.5, '#6a8aa4');
            cv.roundRect(left + 7, at + 10, 31, 31, 3, channel.color || '#214969');
            const logo = tdt.logo(channel);
            if (logo) cv.image(logo, left + 7, at + 10, 31, 31, 3);
            else cv.text(channel.badge || channel.name.slice(0, 2).toUpperCase(), left + 22.5, at + 31, 14, primary,
                { align: 'center', font: 'bold' });
            const textX = left + 46;
            const endX = left + l.listWidth - 8;
            fit(cv, channel.name, textX, at + 19, 17, endX - textX, primary);
            cv.roundRect(textX, at + 24, endX - textX, 3, 1, '#223549');
            if (progress > 0) cv.roundRect(textX, at + 24, (endX - textX) * progress, 3, 1, '#49c5b6');
            cv.text(start, textX, at + 44, 11, primary);
            cv.text(end, endX, at + 44, 11, primary, right);
            fit(cv, info ? info.title : 'Sin EPG', (textX + endX) / 2, at + 44, 11, endX - textX - 74, secondary, centered);
        });
    }

    if (!item) {
        const status = { loading: 'Cargando canales…', offline: 'No se ha podido descargar el catálogo' }[state.status];
        cv.text(status || 'No hay canales en esta lista', x + w / 2, top + l.body / 2, 20, primary, centered);
        return;
    }
    if (state.mode === 'order') {
        const actions = ['Subir canal', 'Bajar canal', 'Restaurar orden del catálogo', 'Orden alfabético'];
        actions.forEach((label, index) => {
            const at = top + index * l.menuRow;
            cv.roundRect(detailX, at, l.detailWidth, l.menuRow - 5, 6, '#173043');
            cv.text(label, detailX + 14, at + 29, 17, primary);
        });
        return;
    }
    const detailLeft = Math.max(detailX, clipLeft);
    const visibleRight = Math.min(detailRight, clipRight);
    if (visibleRight <= detailLeft) return;
    cv.clip(detailLeft, top, visibleRight - detailLeft, l.body);
    if (state.art && programme) {
        const imageWidth = Math.max(l.detailWidth, l.body * state.art.w / state.art.h);
        const imageHeight = imageWidth * state.art.h / state.art.w;
        cv.image(state.art, detailX + (l.detailWidth - imageWidth) / 2, top + (l.body - imageHeight) / 2, imageWidth, imageHeight);
        cv.fillRect(detailX, top, l.detailWidth, l.body, [7, 17, 30, 80]);
    }
    cv.gradientRect(detailX, top, l.detailWidth, 88, [[0, [7, 17, 30, 220]], [1, [7, 17, 30, 0]]]);
    const textX = detailX + 15;
    const title = programme ? programme.title : item.name;
    fit(cv, title, textX, top + 27, 23, l.detailWidth - 30, primary, bold);
    const status = state.guideStatus === 'loading' ? 'Cargando programación…' : 'Sin programación disponible';
    const meta = programme ? programmeTimes(tdt, programme).join(' – ') + '  ·  ' + item.name : status;
    fit(cv, meta, textX, top + 49, 13, l.detailWidth - 30, '#c0d6e9');
    if (programme && programme.description) {
        const descriptionWidth = Math.round(l.detailWidth * 0.62);
        const lines = wrap(cv, programme.description.slice(0, 1900), 16, () => descriptionWidth - 20).slice(0, 14);
        cv.roundRect(textX, top + 69, descriptionWidth, lines.length * 21 + 15, 7, [7, 17, 30, 185]);
        lines.forEach((line, row) => fit(cv, line, textX + 10, top + 93 + row * 21, 16, descriptionWidth - 20, primary));
    }
    if (state.mode !== 'guide') {
        cv.roundRect(detailRight - 137, y + h - 49, 122, 30, 5, '#173f51');
        cv.text('Ver en directo', detailRight - 76, y + h - 29, 14, primary, centered);
    }
    cv.clip(clipLeft, y, clipRight - clipLeft, h);
}

function empty(cv, x, y, w, h, status, loading, offline, detail) {
    cv.text(status === 'offline' ? offline : loading, x + w / 2, y + h / 2, 17, primary, centered);
    if (status === 'offline' && detail) fit(cv, detail, x + w / 2, y + h / 2 + 24, 13, w - 36, secondary, centered);
}

function drawCard(cv, card, x, selected, data, state, art, now, preconditioning) {
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
    let title = card.title;
    if (card.id === 'weather') title += ' - ' + (data.weather ? data.weather.name : data.city);
    if (card.id === 'trip' && data.diagnostics) title += ' · DEMO';
    fit(cv, title, x + w / 2, y + 25, 19, w - 35, primary, { align: 'center', spacing: 2 });
    cv.rampRect(x + 8, y + 35, w - 16, 2, 0, ['#17383e', '#239696', '#17383e']);

    if (card.id === 'trip') trip(cv, x, y, w, h, preconditioning);
    if (card.id === 'radio') radio(cv, x, y, w, h, art);
    if (card.id === 'weather') {
        if (!data.weather) empty(cv, x, y, w, h, data.weatherStatus, 'Cargando el tiempo…',
            'El tiempo no está disponible', data.weatherDetail);
        else if (state.weatherPage === 'rain') weatherRain(cv, x, y, w, h, data.weather, state.weatherDay, art);
        else weatherSummary(cv, x, y, w, h, data.weather, art);
    }
    if (card.id === 'news') news(cv, x, y, w, h, data, state.article, art, now);
    if (card.id === 'tdtworld' && data.tdt) tdtworld(cv, x, y, w, h, data.tdt, selected, clipLeft, clipRight, now);
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
    const records = data.diagnostics && data.telemetry && new Map(data.telemetry.map((row) => [row.signal, row]));
    const thermal = records && records.get('statusPredictiveThermalManagement');
    const active = thermal && thermal.status === 'sample' && thermal.fields
        ? thermal.fields.preconditioningActive : undefined;
    if (data.diagnostics) diagnostics(cv, records);
    else cv.text('Mapa', map.x + map.w / 2, map.y + map.h / 2 + 7, 20, secondary, centered);
    cards.forEach((card, index) => drawCard(cv, card, viewport.x + card.x - scroll,
        state.selected === index, data, state, art, now, active));
    energy(cv, data.energy, art);
}

module.exports = { drawHome };
