'use strict';

const { Recorder, play } = require('./vendor/kit_record.js');
const { Canvas } = require('./vendor/kit_canvas.js');
const { loadArtwork, parseWeather, weatherUrl } = require('./drivehub-data.js');
const { drawCockpit, width, height } = require('./cockpit-view.js');
const { createWeather } = require('./weather-location.js');

const bands = [[0, 192], [192, 86], [278, 122]];
const layerStatus = {
    shown: 'Widget visible',
    waiting: 'Widget en espera',
    suspended: 'Otra capa ocupa el cuadro',
    stalled: 'Esperando imagen',
    hidden: 'Widget oculto',
    error: 'Cluster renderer rechazó la capa'
};

function createCockpit(Client, get, log = console) {
    let renderer;
    let layer;
    let frameKeys;
    let supported = false;
    let status;
    let connectingSince;
    let ownWeather, weatherTime;
    const art = loadArtwork('cockpit-weather.rgba.gz');
    const cv = new Recorder(width, height);
    const surface = new Canvas(width, height);

    function open(now) {
        const client = new Client('javi_bmwlauncher');
        renderer = client;
        connectingSince = now;
        client.on('ready', () => {
            if (renderer !== client) return;
            supported = client.backend === 'id8' && typeof client.targets === 'string' &&
                client.targets.split(',').includes('widget:2240x896');
            if (!supported) {
                status = 'Widget incompatible con esta versión';
                return;
            }
            status = layerStatus.waiting;
            if (layer) return;
            layer = client.image({ target: 'widget', klass: 'overlay', contend: false,
                x: 820, y: 185, w: 600, h: 500, iw: width, ih: height, fps: 2, sampling: 'bilinear' });
        });
        client.on('layer', (ref, state) => {
            if (renderer === client && ref === layer) status = layerStatus[state] || status;
        });
        client.on('target', (target, state) => {
            if (renderer !== client || target !== 'widget') return;
            if (state === 'parked') status = 'Selecciona Cluster renderer en el cuadro';
            if (state === 'unavailable') status = 'El cuadro no admite el widget';
        });
        client.on('refused', (op, ref, reason) => {
            if (renderer !== client || ref !== layer) return;
            status = layerStatus.error;
            log.warn('BMWLauncher: cluster-render: ' + op + ' · ' + reason);
        });
        client.on('disconnected', () => {
            if (renderer !== client) return;
            status = undefined;
            connectingSince = Date.now();
        });
        client.on('error', (error) => {
            log.warn('BMWLauncher: cluster-render: ' + (error && error.code || 'protocolo'));
        });
        client.connect();
    }

    return {
        status(now) {
            if (status) return status;
            return now - connectingSince >= 5000 ? 'Cluster renderer no responde' : 'Conectando al cuadro…';
        },
        update(readings, now, sharedWeather) {
            if (!renderer) open(now);
            if (!renderer.ready || !supported || !layer) return;
            // The rendered session owns one GPS forecast for both displays. Standalone
            // consumers can still own a provider, with the same movement/expiry policy.
            if (arguments.length < 3) {
                weatherTime = now;
                if (!ownWeather) ownWeather = createWeather({ get, url: weatherUrl, parse: parseWeather, now: () => weatherTime }, () => {});
                ownWeather.update(readings.location, now, true);
                sharedWeather = ownWeather.snapshot(now);
            }
            const currentWeather = readings.location && sharedWeather ? { icon: sharedWeather.cockpitIcon,
                temp: sharedWeather.temp, probability: sharedWeather.probability } : undefined;
            const keys = [JSON.stringify(currentWeather),
                JSON.stringify([readings.batteryTemperature, readings.preconditioning === true]),
                JSON.stringify([readings.power, readings.trip.average, readings.trip.averageUnit])];
            if (frameKeys && keys.every((key, i) => key === frameKeys[i])) return;
            cv.reset();
            drawCockpit(cv, readings, currentWeather, art);
            play(cv.words(), surface);
            const rgba = Buffer.from(surface.d.buffer, surface.d.byteOffset, surface.d.byteLength);
            const dirty = frameKeys && bands.filter((_, i) => keys[i] !== frameKeys[i]);
            if (dirty && dirty.length < bands.length) {
                const rects = dirty.map(([y, h]) => ({ x: 0, y, w: width, h }));
                const pixels = dirty.map(([y, h]) => rgba.slice(y * width * 4, (y + h) * width * 4));
                renderer.pixels(layer, rects, Buffer.concat(pixels));
            } else renderer.pixels(layer, null, rgba);
            frameKeys = keys;
        },
        close() {
            if (ownWeather) { ownWeather.close(); ownWeather = undefined; }
            if (!renderer) return;
            renderer.close();
            renderer = undefined;
            layer = undefined;
            frameKeys = undefined;
            status = undefined;
            connectingSince = undefined;
        }
    };
}

module.exports = { createCockpit };
