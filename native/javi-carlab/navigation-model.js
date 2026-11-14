'use strict';

const { StringDecoder } = require('string_decoder');
const displays = require('./navigation-displays');
const maxBytes = 128 * 1024;
const validPoint = (p) => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;

function decodePolyline(encoded) {
    if (typeof encoded !== 'string' || encoded.length > 65536) throw new Error('route-size');
    let cursor = 0, latitude = 0, longitude = 0;
    const points = [];
    function delta() {
        let value = 0, shift = 0, byte;
        do {
            if (cursor >= encoded.length || shift > 30) throw new Error('route-truncated');
            byte = encoded.charCodeAt(cursor++) - 63;
            if (byte < 0 || byte > 63) throw new Error('route-character');
            value += (byte & 31) * Math.pow(2, shift); shift += 5;
            if (value > 0xffffffff) throw new Error('route-overflow');
        } while (byte >= 32);
        return value % 2 ? -(value + 1) / 2 : value / 2;
    }
    while (cursor < encoded.length) {
        latitude += delta(); longitude += delta();
        if (points.length >= 12000) throw new Error('route-points');
        points.push({ latitude: latitude / 1e5, longitude: longitude / 1e5 });
    }
    if (points.length < 2) throw new Error('route-empty');
    return points;
}
function distance(a, b) {
    const radians = Math.PI / 180;
    const dlat = (b.latitude - a.latitude) * radians, dlon = (b.longitude - a.longitude) * radians;
    const h = Math.pow(Math.sin(dlat / 2), 2) + Math.cos(a.latitude * radians) * Math.cos(b.latitude * radians) * Math.pow(Math.sin(dlon / 2), 2);
    return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, h)));
}
function routeGeometry(encoded, destination) {
    const decoded = decodePolyline(encoded);
    // The codec is confirmed in NavController; verify axis order against BMW's independent endpoint.
    if (!validPoint(destination)) throw new Error('route-endpoint-missing');
    const swapped = decoded.map((p) => ({ latitude: p.longitude, longitude: p.latitude }));
    const candidates = [decoded, swapped].filter((list) => list.every(validPoint) && distance(list[list.length - 1], destination) <= 1500);
    if (!candidates.length) throw new Error('route-endpoint-mismatch');
    candidates.sort((a, b) => distance(a[a.length - 1], destination) - distance(b[b.length - 1], destination));
    // Preserve bends at navigation zoom; the view culls segments outside its viewport.
    return candidates[0];
}

function validControls(c) {
    if (c === undefined) return true;
    const text = (s, max) => typeof s === 'string' && s.length <= max;
    if (!c || !Number.isSafeInteger(c.request) || typeof c.busy !== 'boolean' ||
        !['idle', 'loading', 'results', 'detail', 'calculating', 'preview', 'guiding', 'error'].includes(c.status) ||
        !text(c.error, 140) || !text(c.query, 140) || !Array.isArray(c.results) || c.results.length > 32 ||
        !Array.isArray(c.stops) || c.stops.length > 24) return false;
    if (c.searchPhase !== undefined && !['idle', 'session', 'location', 'categories', 'search', 'view', 'results', 'finished'].includes(c.searchPhase)) return false;
    if (c.results.some((r) => !r || !text(r.id, 32) || !/^\d+:\d+$/.test(r.id) || !text(r.name, 140) ||
        !['charger', 'poi', 'address'].includes(r.type) || r.metres !== null && (!Number.isFinite(r.metres) || r.metres < 0) ||
        (r.latitude !== undefined || r.longitude !== undefined) && !validPoint(r) ||
        r.positionState !== undefined && !['pending', 'ready', 'unavailable'].includes(r.positionState))) return false;
    if (c.stops.some((s) => !s || !text(s.name, 140) || !validPoint(s))) return false;
    if (c.selected !== null && (!validPoint(c.selected) || !text(c.selected.name, 140) || !text(c.selected.phone, 140))) return false;
    if (c.selected && (c.selected.type !== undefined && !['charger', 'poi', 'address'].includes(c.selected.type) ||
        c.selected.id !== undefined && (!text(c.selected.id, 32) || !/^\d+:\d+$/.test(c.selected.id)))) return false;
    if (c.selected && c.selected.address != null) {
        const a = c.selected.address, p = a.optionPOILocation || a.optionLocation || a.contactLocation;
        if (!validPoint(p) || p.coordinatesValid !== true || Buffer.byteLength(JSON.stringify(a)) > 24000) return false;
    }
    if (c.selected && c.selected.details !== undefined && (!Array.isArray(c.selected.details) || c.selected.details.length > 3 || c.selected.details.some((s) => !text(s, 140)))) return false;
    return c.plan === null || c.plan && typeof c.plan.charging === 'boolean' && Number.isInteger(c.plan.arrival) && c.plan.arrival >= 0 && c.plan.arrival <= 100 &&
        (c.plan.key === undefined || text(c.plan.key, 32) && /^\d+:\d+$/.test(c.plan.key)) &&
        (c.plan.metres === undefined || Number.isFinite(c.plan.metres) && c.plan.metres >= 0 && c.plan.metres < 50000000) &&
        (c.plan.seconds === undefined || Number.isFinite(c.plan.seconds) && c.plan.seconds >= 0 && c.plan.seconds < 604800);
}

function validate(frame) {
    if (!frame || frame.version !== 1 || !Number.isFinite(frame.at) || !validControls(frame.controls) || !displays.validate(frame.presentation) ||
        !['active', 'inactive', 'calculating', 'unavailable'].includes(frame.state) ||
        !['day', 'night', 'auto'].includes(frame.theme) ||
        !Array.isArray(frame.destinations) || frame.destinations.length > 24 ||
        !Array.isArray(frame.segments) || frame.segments.length > 24 ||
        ![true, false, null].includes(frame.electricRouting) || typeof frame.destinationsKnown !== 'boolean') return false;
    if (frame.currentRoad !== undefined && (typeof frame.currentRoad !== 'string' || frame.currentRoad.length > 140)) return false;
    const turn = frame.instruction;
    if (turn != null && (!['intersection', 'roundabout', 'branch', 'destinationManeuver'].includes(turn.kind) ||
        typeof turn.direction !== 'string' || turn.direction.length > 20 || typeof turn.road !== 'string' || turn.road.length > 140 ||
        turn.metres !== null && (!Number.isFinite(turn.metres) || turn.metres < 0) || turn.exit !== null && (!Number.isInteger(turn.exit) || turn.exit < 0 || turn.exit > 255))) return false;
    if (frame.destinations.some((d) => !d || (d.position !== null && !validPoint(d.position)) ||
        typeof d.charging !== 'boolean' || typeof d.final !== 'boolean' ||
        (d.seconds !== null && (!Number.isFinite(d.seconds) || d.seconds < 0 || d.seconds > 604800)) ||
        (d.metres !== null && (!Number.isFinite(d.metres) || d.metres < 0 || d.metres > 50000000)))) return false;
    if (frame.segments.some((s) => !s || typeof s.name !== 'string' || s.name.length > 100 || typeof s.charging !== 'boolean' ||
        (s.preferences !== null && (!s.preferences || typeof s.preferences.enabled !== 'boolean' ||
        (s.preferences.arrivalMinimum !== null && (!Number.isInteger(s.preferences.arrivalMinimum) || s.preferences.arrivalMinimum < 0 || s.preferences.arrivalMinimum > 100)))))) return false;
    return frame.route === null || (frame.state === 'active' && frame.route &&
        typeof frame.route.encoded === 'string' && frame.route.encoded.length <= 65536 && /^[?-~]+$/.test(frame.route.encoded) &&
        typeof frame.route.key === 'string' && /^\d+:\d+$/.test(frame.route.key) && Number.isFinite(frame.route.at));
}
function consume(receive) {
    const decoder = new StringDecoder('utf8');
    let partial = '';
    return (chunk) => {
        if (chunk.length > 2 * maxBytes) return false;
        const lines = (partial + decoder.write(chunk)).split('\n'); partial = lines.pop();
        if (Buffer.byteLength(partial, 'utf8') > maxBytes) return false;
        for (const line of lines) {
            if (Buffer.byteLength(line, 'utf8') > maxBytes) return false;
            let frame;
            try { frame = JSON.parse(line); } catch (_) { return false; }
            if (!validate(frame)) return false;
            receive(frame);
        }
        return true;
    };
}
function createNavigation() {
    let data, receivedAt, geometry = [], encoded, endpointKey, geometryError;
    return {
        receive(frame, now) {
            data = frame; receivedAt = now;
            if (!frame || !frame.route) { geometry = []; encoded = null; endpointKey = null; geometryError = null; return; }
            const final = frame.destinations.find((d) => d.final);
            const point = final && final.position;
            const end = point && point.latitude + ':' + point.longitude;
            if (encoded === frame.route.encoded && endpointKey === end) return;
            encoded = frame.route.encoded; endpointKey = end;
            try { geometry = routeGeometry(encoded, point); geometryError = null; }
            catch (err) { geometry = []; geometryError = err.message; }
        },
        snapshot(now) {
            if (!data || now < receivedAt || now - receivedAt > 5000 || now < data.at || now - data.at > 5000) return { state: 'unavailable', points: [], destinations: [], segments: [], theme: 'auto' };
            const current = data.route && now >= data.route.at && now - data.route.at < 60000;
            return Object.assign({}, data, { points: current ? geometry : [], geometryError });
        }
    };
}
module.exports = { createNavigation, consume, decodePolyline, routeGeometry, validate, distance };
