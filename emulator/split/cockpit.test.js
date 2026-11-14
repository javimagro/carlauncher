'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCockpit } = require('../../native/javi-carlab/cockpit.js');
const { width, height } = require('../../native/javi-carlab/cockpit-view.js');
test('the cockpit consumes the shared forecast without a second network request', () => {
    const { EventEmitter } = require('node:events');
    let requests = 0, frames = 0;
    class SharedRenderer extends EventEmitter {
        constructor() { super(); this.ready = true; this.backend = 'id8'; this.targets = 'widget:2240x896'; }
        connect() { this.emit('ready'); }
        image() { return 1; }
        pixels() { frames++; }
        close() {}
    }
    const cockpit = createCockpit(SharedRenderer, () => { requests++; });
    const readings = { location: { latitude: 40, longitude: -3 }, trip: {} };
    cockpit.update(readings, 1000, { cockpitIcon: 'clear_day', temp: 21, probability: 0 });
    cockpit.update(readings, 2000, undefined);
    assert.equal(requests, 0); assert.equal(frames, 2); cockpit.close();
});
const { vehicleReadings } = require('../../native/javi-carlab/vehicle-readings.js');

test('the cockpit publishes a selectable ID8 widget and updates telemetry and local weather by band', async () => {
    const calls = [];
    const frames = [];
    let client;
    class Renderer extends EventEmitter {
        connect() {
            client = this;
            this.ready = true;
            this.backend = 'id8';
            this.targets = 'map:874x749,widget:2240x896,popup:2240x896';
            this.emit('ready');
        }
        image(options) { calls.push(options); return 1; }
        pixels(ref, rects, data) {
            assert.equal(ref, 1);
            calls.push({ rects, size: data.length });
            frames.push(Buffer.from(data));
            return true;
        }
        close() { calls.push('closed'); }
    }
    const requests = [];
    const hour = '2026-11-12T13:00';
    const forecast = {
        current: { time: hour, temperature_2m: 24, weather_code: 1, is_day: 1 },
        hourly: { time: [hour], precipitation: [0], precipitation_probability: [10] },
        daily: { time: [], temperature_2m_max: [24], temperature_2m_min: [18], sunrise: [], sunset: [] }
    };
    const cockpit = createCockpit(Renderer, (url) => {
        requests.push(new URL(url).searchParams);
        return Buffer.from(JSON.stringify(forecast));
    });
    const readings = { batteryTemperature: 33, power: 20, trip: { average: 18.6, averageUnit: 'kWh/100 km' } };
    cockpit.update(readings, 1000);
    cockpit.update(readings, 2000);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0], { target: 'widget', klass: 'overlay', contend: false,
        x: 820, y: 185, w: 600, h: 500, iw: width, ih: height, fps: 2, sampling: 'bilinear' });
    assert.deepEqual(calls[1], { rects: null, size: width * height * 4 });
    assert.equal(cockpit.status(2000), 'Widget en espera');
    client.emit('target', 'widget', 'parked');
    assert.equal(cockpit.status(2000), 'Selecciona Cluster renderer en el cuadro');
    client.emit('layer', 99, 'shown');
    assert.equal(cockpit.status(2000), 'Selecciona Cluster renderer en el cuadro');
    client.emit('layer', 1, 'shown');
    assert.equal(cockpit.status(2000), 'Widget visible');
    cockpit.update({ ...readings, power: -5 }, 3000);
    assert.deepEqual(calls[2], { rects: [{ x: 0, y: 278, w: width, h: 122 }], size: width * 122 * 4 });
    assert.equal(requests.length, 0);
    const moving = { ...readings, power: -5, location: { latitude: 40.4168, longitude: -3.7038 } };
    cockpit.update(moving, 4000);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].get('latitude'), '40.417');
    assert.equal(requests[0].get('longitude'), '-3.704');
    cockpit.update(moving, 5000);
    const weatherBand = { rects: [{ x: 0, y: 0, w: width, h: 192 }], size: width * 192 * 4 };
    assert.deepEqual(calls[3], weatherBand);
    cockpit.update({ ...moving, location: undefined }, 6000);
    assert.deepEqual(calls[4], weatherBand);
    await new Promise(setImmediate);
    assert.equal(requests.length, 1);
    const preconditioning = new Map([['statusPredictiveThermalManagement', {
        status: 'sample', fields: { preconditioningActive: true }, sampledAt: 7000, freshForMs: 30000
    }]]);
    const batteryBand = { rects: [{ x: 0, y: 192, w: width, h: 86 }], size: width * 86 * 4 };
    const batteryWithoutIcon = frames[0].subarray(192 * width * 4, 278 * width * 4);
    cockpit.update({ ...moving, location: undefined, preconditioning: vehicleReadings(preconditioning, 7000).preconditioning }, 7000);
    assert.deepEqual(calls[5], batteryBand);
    assert(!frames[4].equals(batteryWithoutIcon), 'a fresh active sample draws the icon');
    cockpit.update({ ...moving, location: undefined, preconditioning: vehicleReadings(preconditioning, 37000).preconditioning }, 37000);
    assert.deepEqual(calls[6], batteryBand);
    assert(frames[5].equals(batteryWithoutIcon), 'the icon disappears when the sample expires');
    cockpit.close();
    assert.equal(calls[7], 'closed');
});
