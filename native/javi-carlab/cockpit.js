'use strict';

const { Recorder, play } = require('./vendor/kit_record.js');
const { Canvas } = require('./vendor/kit_canvas.js');
const { loadArtwork, parseWeather, weatherUrl } = require('./drivehub-data.js');
const { drawCockpit, telemetry, bands } = require('./cockpit-view.js');
const { createWeather } = require('./weather-location.js');

const layerStatus = {
    shown: 'Widget visible',
    waiting: 'Widget en espera',
    suspended: 'Otra capa ocupa el cuadro',
    stalled: 'Esperando imagen',
    hidden: 'Widget oculto',
    error: 'Cluster renderer rechazó la capa'
};

function createCockpit(Client, get, log = console) {
    const { x, y, w: width, h: height } = telemetry;
    let renderer;
    let layer;
    let frameKeys;
    let supported = false;
    let status;
    let visible = false;
    let parked = false;
    let targetState;
    let focusRequested = false;
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
            focusRequested = false;
            supported = client.backend === 'id8' && typeof client.targets === 'string' &&
                client.targets.split(',').includes('widget:2240x896');
            if (!supported) {
                status = 'Widget incompatible con esta versión';
                return;
            }
            status = layerStatus.waiting;
            parked = false;
            targetState = undefined;
            if (layer) return;
            layer = client.image({ target: 'widget', klass: 'overlay', contend: false,
                x, y, w: width, h: height, iw: width, ih: height, fps: 2, sampling: 'bilinear' });
        });
        client.on('layer', (ref, state) => {
            if (renderer !== client || ref !== layer) return;
            status = layerStatus[state] || status;
            visible = state === 'shown';
            if (visible) parked = false;
        });
        client.on('target', (target, state) => {
            if (renderer !== client || target !== 'widget') return;
            targetState = state;
            if (state === 'shown') parked = false;
            if (state === 'parked' || state === 'unavailable') {
                parked = true;
                visible = false;
                status = state === 'parked' ? 'Selecciona Cluster renderer en el cuadro' : 'El cuadro no admite el widget';
            }
        });
        client.on('refused', (op, ref, reason) => {
            if (renderer !== client || ref !== layer) return;
            if (op === 'renew_widget_focus') { focusRequested = false; return; }
            log.warn('BMWLauncher: cluster-render: ' + op + ' · ' + reason);
            if (op === 'focus_widget' || op === 'cancel_widget_focus') { focusRequested = false; return; }
            visible = false;
            parked = true;
            status = layerStatus.error;
        });
        client.on('disconnected', () => {
            if (renderer !== client) return;
            focusRequested = false;
            status = undefined;
            visible = false;
            connectingSince = Date.now();
        });
        client.on('error', (error) => {
            log.warn('BMWLauncher: cluster-render: ' + (error && error.code || 'protocolo'));
        });
        client.connect();
    }

    return {
        visible: () => visible,
        status(now) {
            if (status) return status;
            return now - connectingSince >= 5000 ? 'Cluster renderer no responde' : 'Conectando al cuadro…';
        },
        requestFocus() {
            if (!renderer || !renderer.ready) return 'waiting';
            if (!supported || !renderer.widgetFocusLease || visible || targetState === 'shown') return 'skipped';
            if (targetState !== 'parked' || !layer || !frameKeys) return 'waiting';
            focusRequested = renderer.focusWidget(layer);
            return focusRequested ? 'sent' : 'skipped';
        },
        renewFocus() {
            return focusRequested && renderer.renewWidgetFocus(layer);
        },
        cancelFocus() {
            if (focusRequested) renderer.cancelWidgetFocus(layer);
            focusRequested = false;
        },
        update(readings, now, sharedWeather) {
            if (!renderer) open(now);
            if (!renderer.ready || !supported || !layer) return;
            if (parked && frameKeys) {
                if (ownWeather) ownWeather.suspend();
                return;
            }
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
            visible = false;
            parked = false;
            targetState = undefined;
            focusRequested = false;
            connectingSince = undefined;
        }
    };
}

module.exports = { createCockpit };
