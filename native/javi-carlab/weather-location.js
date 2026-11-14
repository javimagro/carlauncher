'use strict';

// DriveHub: forecast age 10 minutes, movement 1 km, periodic check every minute.
const refreshMs = 10 * 60 * 1000, checkMs = 60000, movementKm = 1;
const validLocation = (p) => !!p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
function distance(a, b) {
    const lat = (a.latitude + b.latitude) * Math.PI / 360;
    return 111.2 * Math.hypot(a.latitude - b.latitude, (a.longitude - b.longitude) * Math.cos(lat));
}
function createWeather(options, changed) {
    const clock = options.now || Date.now;
    let cache = options.cache;
    if (!cache || !validLocation(cache.location) || !Number.isFinite(cache.at) || !cache.value || !Number.isFinite(cache.value.temp)) cache = null;
    let location, active = false, closed = false, pending = false, generation = 0, checkAt = 0, retryAt = 0, failed = false;
    let value, status = 'location';
    function usable(now) {
        return active && location && cache && now >= cache.at && now - cache.at < refreshMs * 2 && distance(cache.location, location) < movementKm ? cache.value : undefined;
    }
    function publish(now) {
        const next = usable(now);
        const nextStatus = !location ? 'location' : failed ? 'offline' : next ? (now - cache.at >= refreshMs ? 'stale' : 'ready') : 'loading';
        if (next !== value || nextStatus !== status) { value = next; status = nextStatus; changed(value, status, cache && cache.at); }
    }
    function suspend() {
        if (active) { active = false; generation++; checkAt = 0; }
    }
    return {
        update(point, now, visible) {
            if (closed) return;
            if (!visible) { suspend(); return; }
            active = true;
            if (!validLocation(point)) {
                if (location) { generation++; checkAt = retryAt = 0; failed = false; }
                location = undefined; publish(now); return;
            }
            location = { latitude: point.latitude, longitude: point.longitude };
            publish(now);
            if (pending || now < retryAt || now < checkAt) return;
            checkAt = now + checkMs;
            if (cache && now >= cache.at && now - cache.at < refreshMs && distance(cache.location, location) < movementKm) return;
            const request = { location, generation };
            const valid = () => !closed && active && request.generation === generation && location && distance(request.location, location) < movementKm;
            const rounded = { latitude: Number(location.latitude.toFixed(3)), longitude: Number(location.longitude.toFixed(3)) };
            pending = true; failed = false; publish(now);
            Promise.resolve().then(() => valid() ? options.get(options.url(rounded), 512 * 1024) : null).then((bytes) => {
                if (!bytes || !valid()) return;
                const forecast = options.parse(JSON.parse(bytes.toString('utf8')), 'Ubicación actual');
                cache = { location: request.location, at: clock(), value: forecast };
                if (options.store) options.store(cache);
                retryAt = 0; failed = false;
            }).catch(() => {
                if (!valid()) return;
                retryAt = clock() + checkMs; failed = true;
            }).then(() => {
                pending = false;
                if (!valid()) checkAt = 0;
                if (!closed && active) publish(clock());
            });
        },
        snapshot: usable,
        suspend,
        close() { closed = true; suspend(); }
    };
}
module.exports = { createWeather, distance, validLocation, refreshMs, movementKm };
