'use strict';

// Read-only route observer. User commands live separately in navegacion-acciones.
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { createActions } = require('./navegacion-acciones.js');
const { instruction, description } = require('./navegacion-indicaciones.js');
const { createDisplays } = require('./navegacion-pantallas.js');
const prefix = 'de.bmw.infotainment.navigation.';
const services = {
    guidance: { name: prefix + 'guiding.Guidance', attributes: ['guidanceState', 'currentRoute', 'allDestinationsInfo', 'conclusiveDart', 'currentRoad'] },
    routing: { name: prefix + 'routing.Routing', methods: ['exportActiveRoute'], broadcasts: ['routeExported'] },
    trips: { name: prefix + 'routing2.Routing2', attributes: ['currentTrips', 'eRoutesOn'] },
    theme: { name: prefix + 'mapsettings.MapSettings', attributes: ['dayNightMode'] },
    light: { name: 'de.bmw.infotainment.vehicle.Vehicle', instance: '1', attributes: ['statusDayNightChangeOver'] }
};
const instance = 'Main_Instance';
const routeKey = (r) => r && Number.isInteger(r.sessionID) && Number.isInteger(r.routeHandle)
    ? r.sessionID + ':' + r.routeHandle : null;
const active = (s) => s === 2 || s === 'ACTIVE';
const text = (s) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 100) : '';
function position(p) {
    return p && p.coordinatesValid === true && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
        Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180 ? { latitude: p.latitude, longitude: p.longitude } : null;
}
function destination(d) {
    d = d || {};
    return { position: position(d.position), charging: d.isChargingStation === true, final: d.isCheckeredFlag === true,
        seconds: Number.isInteger(d.travelTime) && d.travelTime < 604800 ? d.travelTime : null,
        metres: d.formattedDistance && Number.isFinite(d.formattedDistance.rawDistance) &&
            d.formattedDistance.rawDistance >= 0 ? d.formattedDistance.rawDistance : null };
}
function locationName(union) {
    const location = union && (union.optionPOILocation || union.optionLocation || union.contactLocation);
    if (!location) return '';
    if (typeof location.name === 'string') return text(location.name);
    const names = location.textDescription && location.textDescription.textDescriptorList;
    const name = names && (names.LOCATION_NAME || names['1'] || names.FULL_ADDRESS || names['2']);
    return text(name && name.orthography);
}
function tripSummary(trips, route) {
    const found = Array.isArray(trips) && trips.find((t) => t.active === true && routeKey(t.routeIdentifer) === routeKey(route));
    const segments = found && found.tripDefinition && found.tripDefinition.tripSegment;
    if (!Array.isArray(segments)) return [];
    return segments.slice(0, 24).map((s) => {
        const preferences = s.routeOptions && s.routeOptions.eRoutePreference;
        return { name: locationName(s.destination), charging: s.isERouteTripSegment === true,
            destinationType: s.destinationType, preferences: preferences ? {
                enabled: preferences.eRoutesOn === true,
                arrivalMinimum: Number.isInteger(preferences.minSoCAtFinalDestination) && preferences.minSoCAtFinalDestination <= 100
                    ? preferences.minSoCAtFinalDestination : null
            } : null };
    });
}
function polyline(bytes) {
    if (typeof bytes === 'string') return bytes.length <= 65536 && /^[?-~]+$/.test(bytes) ? bytes : null;
    if (!(Buffer.isBuffer(bytes) || Array.isArray(bytes) || bytes instanceof Uint8Array) || bytes.length > 65536) return null;
    // Never let Buffer's byte masking turn an invalid external value into an encoded point.
    if (Array.prototype.some.call(bytes, (b) => !Number.isInteger(b) || b < 63 || b > 126)) return null;
    return bytes.length ? Buffer.from(bytes).toString('ascii') : null;
}

function createProbe(builders, options) {
    options = options || {};
    const now = options.now || Date.now;
    const every = options.every || setInterval;
    const cancel = options.cancel || clearInterval;
    const records = {};
    const proxies = [];
    const subscriptions = [];
    const timers = [];
    const connections = {};
    let stopped = false, route, request, exported, routing, exporting = false, lastAttempt = -Infinity, routeStatus = 'waiting', automaticTheme;
    const safe = (fn) => Promise.resolve().then(fn).catch(() => undefined);
    const dispose = (p) => p && typeof p.dispose === 'function' ? safe(() => p.dispose()) : Promise.resolve();
    function changed(name, value) {
        if (stopped) return;
        records[name] = { value, at: now() };
        if (name === 'statusDayNightChangeOver') {
            const mode = value && value.dayNightChangeOver;
            if ([1, 'TAG'].includes(mode)) automaticTheme = 'day';
            else if ([2, 'NACHT'].includes(mode)) automaticTheme = 'night';
            else if (![0, 'KEINE_AENDERUNG'].includes(mode)) automaticTheme = undefined;
        }
        if (name === 'currentRoute') {
            if (routeKey(route) !== routeKey(value)) {
                request = null; exported = null; lastAttempt = -Infinity;
                delete records.allDestinationsInfo; delete records.currentTrips; delete records.conclusiveDart; delete records.currentRoad;
            }
            route = value;
        }
        if (name === 'guidanceState' && !active(value)) { request = null; exported = null; routeStatus = 'inactive'; }
    }
    function watch(proxy, name) {
        let pending = false, notifications = 0;
        const attr = proxy[name];
        async function read() {
            if (pending || stopped) return;
            pending = true;
            const serial = notifications;
            const sourceRoute = routeKey(route);
            try {
                const value = await attr.getValue();
                const tiedToRoute = ['allDestinationsInfo', 'currentTrips', 'conclusiveDart', 'currentRoad'].includes(name);
                if (serial === notifications && (!tiedToRoute || sourceRoute === routeKey(route))) changed(name, value);
            }
            catch (_) { /* A stale value expires in snapshot, never becomes zero. */ }
            finally { pending = false; }
        }
        safe(async () => {
            const id = await attr.subscribe((v) => { notifications++; changed(name, v); });
            if (stopped) await safe(() => attr.unsubscribe(id));
            else subscriptions.push([attr, id]);
        });
        read();
        timers.push(every(read, 5000));
    }
    function fresh(name) {
        const r = records[name];
        return r && now() >= r.at && now() - r.at <= 15000 ? r.value : undefined;
    }
    function exportedRoute(event) {
        if (!event || stopped || !request || now() - request.at > 15000 || !active(fresh('guidanceState')) ||
            routeKey(event.routeIdentifier) !== request.key || request.key !== routeKey(fresh('currentRoute'))) return;
        if (event.referencingMethod !== 3 && event.referencingMethod !== 'POLYLINE') return;
        request = null;
        const encoded = event.exportSuccess === true && polyline(event.encodedRoute);
        if (!encoded) { routeStatus = 'format'; return; }
        exported = { encoded, key: routeKey(event.routeIdentifier), at: now() };
        routeStatus = 'ready';
    }
    async function exportRoute() {
        if (stopped || exporting || !routing || !active(fresh('guidanceState')) || !routeKey(fresh('currentRoute'))) return;
        if (request && now() - request.at <= 15000) return;
        if (request) { request = null; routeStatus = 'timeout'; }
        if (now() - lastAttempt < 20000) return;
        const pending = { key: routeKey(route), at: now() };
        request = pending; lastAttempt = now(); exporting = true; routeStatus = exported ? 'ready' : 'loading';
        try {
            const result = await routing.exportActiveRoute({ referencingMethod: 'POLYLINE' });
            if (stopped || request !== pending) return;
            const verdict = result && typeof result === 'object' ? result.ExportRouteError : result;
            // Some SDK versions resolve void and report success only through routeExported.
            if (verdict != null && ![0, 'NO_ERROR'].includes(verdict)) {
                request = null; routeStatus = 'unavailable';
            }
        } catch (_) { if (!stopped && request === pending) { request = null; routeStatus = 'unavailable'; } }
        finally { exporting = false; }
    }
    async function connect(key) {
        const connection = connections[key] || (connections[key] = { pending: false, ready: false, retryAt: 0 });
        if (stopped || connection.pending || connection.ready || now() < connection.retryAt) return;
        connection.pending = true;
        const descriptor = services[key];
        let proxy;
        try {
            proxy = await builders.buildAndInitTypedProxy(descriptor.name, descriptor.instance || instance, { timeoutMs: 10000 });
            if (stopped) return dispose(proxy);
            if (key === 'routing') {
                const id = await proxy.routeExported.subscribe(exportedRoute);
                if (stopped) { safe(() => proxy.routeExported.unsubscribe(id)); return dispose(proxy); }
                subscriptions.push([proxy.routeExported, id]);
                routing = proxy; exportRoute();
            } else descriptor.attributes.forEach((name) => watch(proxy, name));
            proxies.push(proxy); connection.ready = true;
        } catch (_) {
            dispose(proxy);
            connection.retryAt = now() + 5000;
            if (!stopped && key === 'routing') routeStatus = 'unavailable';
        } finally { connection.pending = false; }
    }
    Object.keys(services).forEach(connect);
    timers.push(every(() => Object.keys(services).forEach(connect), 5000));
    timers.push(every(exportRoute, 1000));
    return {
        snapshot() {
            const state = fresh('guidanceState');
            const live = active(state) && routeKey(fresh('currentRoute'));
            const line = live && exported && exported.key === routeKey(route) && now() - exported.at < 60000 ? exported : null;
            const destinations = live && fresh('allDestinationsInfo');
            return { version: 1, at: now(), state: state === undefined ? 'unavailable' : active(state) ? 'active' :
                (state === 1 || state === 'CALCULATING_ROUTE' ? 'calculating' : 'inactive'),
                routeStatus: line ? 'ready' : routeStatus === 'ready' ? 'expired' : routeStatus,
                route: line ? { encoded: line.encoded, key: line.key, at: line.at } : null,
                destinations: Array.isArray(destinations) ? destinations.slice(0, 24).map(destination) : [],
                destinationsKnown: Array.isArray(destinations),
                instruction: live ? instruction(fresh('conclusiveDart')) : null,
                currentRoad: live ? description(fresh('currentRoad')) : '',
                segments: live ? tripSummary(fresh('currentTrips'), route) : [],
                electricRouting: typeof fresh('eRoutesOn') === 'boolean' ? fresh('eRoutesOn') : null,
                theme: [1, 'DAY'].includes(fresh('dayNightMode')) ? 'day' : [2, 'NIGHT'].includes(fresh('dayNightMode')) ? 'night' :
                    fresh('statusDayNightChangeOver') && automaticTheme || 'auto' };
        },
        stop() {
            if (stopped) return;
            stopped = true; timers.forEach(cancel); request = null; exported = null;
            // Dispose independently: an unresponsive unsubscribe must not keep other proxies alive.
            subscriptions.forEach(([attr, id]) => safe(() => attr.unsubscribe(id)));
            proxies.forEach(dispose);
        }
    };
}

function report(builders, endpoint = '/run/javi-carlab/navigation.sock') {
    let probe, actions, displays, socket, timer;
    function send() {
        if (!probe) return;
        if (!socket) {
            const peer = net.createConnection(endpoint); socket = peer;
            const decoder = new StringDecoder('utf8');
            let partial = '';
            peer.on('data', (chunk) => {
                if (peer !== socket || !actions) return;
                if (chunk.length > 65536) { peer.destroy(); return; }
                const lines = (partial + decoder.write(chunk)).split('\n'); partial = lines.pop();
                if (Buffer.byteLength(partial) > 65536 || lines.length > 8) { peer.destroy(); return; }
                for (const line of lines) {
                    if (Buffer.byteLength(line) > 65536) { peer.destroy(); return; }
                    try { actions.command(JSON.parse(line)); } catch (_) { peer.destroy(); return; }
                }
            });
            peer.on('error', () => {});
            peer.on('connect', () => { if (socket === peer) send(); });
            peer.on('close', () => { if (socket === peer) socket = null; });
        } else if (!socket.connecting && !socket.destroyed && !socket.bufferSize) {
            socket.write(JSON.stringify(Object.assign({}, probe.snapshot(), { controls: actions.snapshot(), presentation: displays.snapshot() })) + '\n', 'utf8');
        }
    }
    return { show(on) {
        if (on && !probe) { probe = createProbe(builders); actions = createActions(builders); displays = createDisplays(builders); timer = setInterval(send, 1000); send(); }
        else if (!on && probe) { clearInterval(timer); probe.stop(); actions.stop(); displays.stop(); probe = actions = displays = null; if (socket) socket.destroy(); socket = null; }
    } };
}
module.exports = { services, instance, createProbe, report, position, polyline, tripSummary };
