'use strict';

const { Recorder, play } = require('./vendor/kit_record.js');
const { Canvas } = require('./vendor/kit_canvas.js');
const { loadArtwork, parseWeather, weatherUrl } = require('./drivehub-data.js');
const { drawCockpit, width, height } = require('./cockpit-view.js');

const refreshMs = 10 * 60 * 1000;
const retryMs = 60 * 1000;
const movementKm = 5;
const bands = [[0, 192], [192, 86], [278, 122]];
const layerStatus = {
    shown: 'Widget visible',
    waiting: 'Widget en espera',
    suspended: 'Otra capa ocupa el cuadro',
    stalled: 'Esperando imagen',
    hidden: 'Widget oculto',
    error: 'Cluster renderer rechazó la capa'
};

function distance(a, b) {
    const latitude = (a.latitude + b.latitude) * Math.PI / 360;
    return 111 * Math.hypot(a.latitude - b.latitude, (a.longitude - b.longitude) * Math.cos(latitude));
}

function weatherForCockpit(data) {
    const weather = parseWeather(data, '');
    const current = data.current;
    let icon = weather.kind;
    if (icon === 'sunny' || icon === 'night' || current.weather_code === 1 || current.weather_code === 2) {
        const day = current.is_day === 0 ? 'night' : 'day';
        icon = (current.weather_code === 1 || current.weather_code === 2 ? 'partly_cloudy_' : 'clear_') + day;
    }
    return { icon, temp: weather.temp, probability: weather.probability };
}

function createCockpit(Client, get, log = console) {
    let renderer;
    let layer;
    let frameKeys;
    let supported = false;
    let status;
    let connectingSince;
    let weather;
    let requested;
    let retryAt = 0;
    let pending = false;
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

    function requestWeather(location, now) {
        if (!location || pending || now < retryAt ||
            (requested && now - requested.at < refreshMs && distance(requested.location, location) < movementKm)) return;
        // Forecast grid accuracy does not require the original GPS precision.
        const point = { latitude: Number(location.latitude.toFixed(2)), longitude: Number(location.longitude.toFixed(2)) };
        const request = { location, at: now };
        requested = request;
        pending = true;
        Promise.resolve().then(() => get(weatherUrl(point), 512 * 1024, 8000))
            .then((bytes) => {
                weather = { value: weatherForCockpit(JSON.parse(bytes.toString('utf8'))), request };
            })
            .catch(() => {
                requested = undefined;
                retryAt = Date.now() + retryMs;
            })
            .then(() => { pending = false; });
    }

    return {
        status(now) {
            if (status) return status;
            return now - connectingSince >= 5000 ? 'Cluster renderer no responde' : 'Conectando al cuadro…';
        },
        update(readings, now) {
            if (!renderer) open(now);
            if (!renderer.ready || !supported || !layer) return;
            requestWeather(readings.location, now);
            const currentWeather = readings.location && weather &&
                now - weather.request.at < 2 * refreshMs &&
                distance(weather.request.location, readings.location) < movementKm ? weather.value : undefined;
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
