'use strict';

const { mix } = require('./vendor/kit_canvas.js');
const width = 480;
const height = 400;
const center = width / 2;
const foreground = '#f0f6fa';
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
    const labelWidth = cv.textWidth(label, 42, bold);
    const iconGap = 12;
    const batteryWidth = 20;
    const preconditioningSpace = preconditioning === true ? preconditioningIconWidth + iconGap : 0;
    const rowWidth = preconditioningSpace + batteryWidth + iconGap + labelWidth;
    const left = center - rowWidth / 2;
    const batteryX = left + preconditioningSpace;
    if (preconditioning === true) preconditioningIcon(cv, left, 206);
    cv.strokeRoundRect(batteryX, 205, batteryWidth, 27, 3, 2, foreground);
    cv.fillRect(batteryX + 6, 201, 8, 4, foreground);
    cv.text(label, batteryX + batteryWidth + iconGap + labelWidth / 2, 234, 42, tint, bold);

    const stops = [[0, red], [10, yellow], [25, green], [40, green], [45, yellow], [50, orange], [70, red]];
    const point = (t) => [65 + 350 * t, 261 - 31 * Math.pow(t, 7)];
    for (let i = 0; i < 70; i++) {
        const upper = stops.findIndex(([temp]) => temp > i);
        const [start, from] = stops[upper - 1];
        const [end, to] = stops[upper];
        const color = known ? mix(from, to, (i - start) / (end - start)) : '#354c62';
        const [x0, y0] = point(i / 70), [x1, y1] = point((i + 1) / 70);
        cv.line(x0, y0, x1, y1, 4 + 15 * Math.pow(i / 70, 5), color);
    }
    if (known) {
        const [x, y] = point(Math.min(70, Math.max(0, value)) / 70);
        cv.line(x, y - 9, x, y + 9, 2, foreground);
    }
}

function rain(cv) {
    const cloud = [[7, 16], [5, 15], [4.6, 13], [5.2, 11.1], [6.6, 10.1],
        [6.9, 7.7], [8.7, 5.8], [11, 5], [13.4, 5.8], [15.6, 4.6],
        [18.3, 4.7], [20.4, 6], [21.6, 7.7], [21.8, 9.5], [24, 10.7],
        [24.9, 12.7], [24.1, 14.8], [21.5, 16], [7, 16]];
    for (const path of [cloud, [[8, 20], [5, 25]], [[14, 20], [11, 25]], [[20, 20], [17, 25]]]) {
        for (let i = 1; i < path.length; i++) {
            const [x0, y0] = path[i - 1], [x1, y1] = path[i];
            cv.line(269 + x0, 137 + y0, 269 + x1, 137 + y1, 1.8, blue);
        }
    }
}

function drawCockpit(cv, readings, weather, art) {
    cv.clear([0, 0, 0, 0]);
    cv.roundRect(0, 0, width, height, 18, '#0c1c2b');
    if (weather) {
        cv.text('UBICACIÓN ACTUAL', center, 34, 19, foreground, centered);
        const icon = art(weather.icon);
        if (icon) {
            const scale = Math.min(180 / icon.w, 148 / icon.h);
            cv.image(icon, 147 - icon.w * scale / 2, 117 - icon.h * scale / 2, icon.w * scale, icon.h * scale);
        }
        cv.text(text(weather.temp) + '°', 321, 117, 64, foreground, centered);
        rain(cv);
        cv.text(text(weather.probability) + '%', 331, 161, 25, blue, centered);
    } else {
        cv.text('Tiempo de la ubicación actual', center, 34, 19, foreground, centered);
        cv.text('– °C', center, 130, 49, '#8da3b5', centered);
    }
    battery(cv, readings.batteryTemperature, readings.preconditioning);
    const power = Math.abs(readings.power) < 0.05 ? 0 : readings.power;
    const powerColor = !Number.isFinite(power) ? foreground : power < 0 ? '#70c5f1' :
        power >= 80 ? '#e65059' : power >= 30 ? yellow : green;
    const powerText = text(power, Math.abs(power) < 10 ? 1 : 0).replace(/,0$/, '');
    cv.text(powerText + ' kW', center, 320, 39, powerColor, bold);
    cv.line(62, 342, width - 62, 342, 2, '#4a9bdc');
    const unit = readings.trip.averageUnit || 'kWh/100 km';
    cv.text(text(readings.trip.average, 1) + ' ' + unit, center, 378, 29, foreground, centered);
}

module.exports = { drawCockpit, preconditioningIcon, width, height };
