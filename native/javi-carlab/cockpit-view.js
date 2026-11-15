'use strict';

const { mix } = require('./vendor/kit_canvas.js');
// Coordinates in the 2240 × 896 ID8 widget. The map and the telemetry share the composition.
// Keep telemetry inside the visible intersection of the normal and M layouts.
const composition = { x: 520, y: 143, w: 1120, h: 620 };
const mapArea = { x: composition.x, y: composition.y, w: Math.round(composition.w * .69), h: composition.h };
const telemetry = { x: 1130, y: 190, w: 400, h: 510 };
const bands = [[0, 225], [225, 123], [348, 152]];
const axis = (fraction) => Math.round(composition.x + composition.w * fraction - telemetry.x);
const size = (fraction) => Math.round(composition.h * fraction);
const weatherArtX = axis(.71);
const weatherTextX = axis(.837);
const weatherTitleX = axis(.764);
const batteryX = axis(.74);
const powerX = axis(.723);
const foreground = '#f2f5f7';
const blue = '#79c9ec';
const green = '#7bd88f';
const yellow = '#f2cf6c';
const orange = '#ffa45b';
const red = '#ff6b73';
const preconditioningIconWidth = 41;
const centered = { align: 'center' };
const bold = { align: 'center', font: 'bold' };
const text = (value, decimals = 0) => Number.isFinite(value)
    ? value.toFixed(decimals).replace('.', ',') : '–';

function centeredText(cv, label, x, y, fontSize, color, opts, maximumWidth) {
    const fitted = Math.min(fontSize, fontSize * maximumWidth / cv.textWidth(label, fontSize, opts));
    cv.text(label, x, y, fitted, color, opts);
}

function preconditioningIcon(cv, x, y, color = blue) {
    const bodyWidth = preconditioningIconWidth - 4;
    cv.strokeRoundRect(x, y, bodyWidth, 24, 3, 2, color);
    cv.fillRect(x + bodyWidth, y + 8, 4, 8, color);
    const cx = x + 18;
    const cy = y + 12;
    const blade = [[-0.5, -2], [-3.7, -5.1], [-2.9, -8.1], [2.2, -7.2]];
    for (let i = 0; i < 3; i++) {
        const angle = i * 2 * Math.PI / 3;
        const cos = Math.cos(angle);
        const sin = Math.sin(angle);
        cv.quad(blade.map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]), color);
    }
    cv.circle(cx, cy, 2.1, color);
}

function battery(cv, value, preconditioning) {
    const known = Number.isFinite(value);
    const tint = !known ? '#8da3b5' : value < 10 || value > 50 ? red :
        value < 25 || (value > 40 && value <= 45) ? yellow : value > 45 ? orange : green;
    const label = text(value) + ' °C';
    const fontSize = size(.072), labelWidth = cv.textWidth(label, fontSize, bold);
    const markerWidth = cv.textWidth('HV', 15), iconGap = 8;
    const batteryWidth = 25;
    const preconditioningSpace = preconditioning === true ? preconditioningIconWidth + iconGap : 0;
    const rowWidth = preconditioningSpace + batteryWidth + 2 * iconGap + labelWidth + markerWidth;
    const left = batteryX - rowWidth / 2;
    const iconX = left + preconditioningSpace;
    const labelX = iconX + batteryWidth + iconGap;
    if (preconditioning === true) preconditioningIcon(cv, left, 250);
    cv.strokeRoundRect(iconX, 246, batteryWidth, 31, 3, 2, foreground);
    cv.fillRect(iconX + 8, 241, 9, 4, foreground);
    cv.text(label, labelX + labelWidth / 2, 277, fontSize, tint, bold);
    cv.text('HV', labelX + labelWidth + iconGap, 277, 15, '#a9c4dc');

    const stops = [[0, red], [10, yellow], [25, green], [40, green], [45, yellow], [50, orange], [70, red]];
    const gaugeWidth = Math.round(composition.w * .275);
    const point = (t) => [batteryX + gaugeWidth * (t - .5), 311 - 37 * Math.pow(t, 7)];
    for (let i = 0; i < 70; i++) {
        const upper = stops.findIndex(([temp]) => temp > i);
        const [start, from] = stops[upper - 1];
        const [end, to] = stops[upper];
        const color = known ? mix(from, to, (i - start) / (end - start)) : '#354c62';
        const [x0, y0] = point(i / 70), [x1, y1] = point((i + 1) / 70);
        cv.line(x0, y0, x1, y1, 4 + 16 * Math.pow(i / 70, 5), color);
    }
    cv.text('0°', point(0)[0], 333, 12, '#a9c4dc', centered);
    cv.text('70°', point(1)[0], 321, 12, '#a9c4dc', centered);
    if (known) {
        const [start] = point(25 / 70), [end] = point(40 / 70);
        cv.strokeRoundRect(start, 310, end - start, 8, 2, 1, '#57ab78');
        const [x, y] = point(Math.min(70, Math.max(0, value)) / 70);
        cv.line(x, y - 10, x, y + 10, 2, foreground);
    }
}

function rain(cv, left, top) {
    const cloud = [[7, 16], [5, 15], [4.6, 13], [5.2, 11.1], [6.6, 10.1],
        [6.9, 7.7], [8.7, 5.8], [11, 5], [13.4, 5.8], [15.6, 4.6],
        [18.3, 4.7], [20.4, 6], [21.6, 7.7], [21.8, 9.5], [24, 10.7],
        [24.9, 12.7], [24.1, 14.8], [21.5, 16], [7, 16]];
    const scale = size(.075) / 30;
    for (const path of [cloud, [[8, 20], [5, 25]], [[14, 20], [11, 25]], [[20, 20], [17, 25]]]) {
        for (let i = 1; i < path.length; i++) {
            const [x0, y0] = path[i - 1], [x1, y1] = path[i];
            cv.line(left + x0 * scale, top + y0 * scale, left + x1 * scale, top + y1 * scale, 2.3, blue);
        }
    }
}

function drawCockpit(cv, readings, weather, art) {
    cv.clear([0, 0, 0, 0]);
    const weatherWidth = (telemetry.w - weatherTextX - 6) * 2;
    cv.text('UBICACIÓN ACTUAL', weatherTitleX, 61, size(.048), foreground, centered);
    if (weather) {
        const icon = art(weather.icon);
        if (icon) {
            const scale = Math.min(151 / icon.w, 158 / icon.h);
            const clouds = weather.icon === 'cloudy' || weather.icon === 'partly_cloudy_day' || weather.icon === 'partly_cloudy_night';
            const artWidth = icon.w * scale, artHeight = icon.h * scale * (clouds ? .85 : 1);
            cv.image(icon, weatherArtX - artWidth / 2, 143 - artHeight / 2, artWidth, artHeight);
        }
        centeredText(cv, text(weather.temp) + '°', weatherTextX, 153, size(.119), foreground, centered, weatherWidth);
        const probability = text(weather.probability) + '%';
        const iconWidth = size(.075), gap = size(.018), rainSize = size(.06);
        const rainWidth = iconWidth + gap + cv.textWidth(probability, rainSize);
        const rainLeft = Math.min(weatherTextX - rainWidth / 2, telemetry.w - rainWidth - 6);
        rain(cv, rainLeft, 176);
        cv.text(probability, rainLeft + iconWidth + gap, 211, rainSize, blue);
    } else {
        centeredText(cv, '– °C', weatherTextX, 153, size(.119), '#8da3b5', centered, weatherWidth);
    }
    battery(cv, readings.batteryTemperature, readings.preconditioning);
    const power = Math.abs(readings.power) < 0.05 ? 0 : readings.power;
    const powerColor = !Number.isFinite(power) ? foreground : power < 0 ? '#70c5f1' :
        power >= 80 ? '#e65059' : power >= 30 ? yellow : green;
    const powerText = text(power, Math.abs(power) < 10 ? 1 : 0).replace(/,0$/, '');
    const powerWidth = Math.round(composition.w * .30);
    cv.text(powerText + ' kW', powerX, 400, size(.0731), powerColor, bold);
    cv.line(powerX - powerWidth / 2, 428, powerX + powerWidth / 2, 428, 2, '#4b9de0');
    const unit = readings.trip.averageUnit || 'kWh/100 km';
    const average = text(readings.trip.average, 1) + ' ' + unit;
    centeredText(cv, average, powerX, 480, size(.0561), '#ffffff', centered, powerWidth);
}

module.exports = { drawCockpit, preconditioningIcon, composition, mapArea, telemetry, bands };
