'use strict';

const { distance } = require('./navigation-model');
const day = 86400000;
const maxDestinations = 100;
const maxUses = 120;
const maxHistoryBytes = 200 * 1024;
const validPoint = (p) => p && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
    Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180;
const identity = (p) => Math.round(p.latitude * 1e5) + ':' + Math.round(p.longitude * 1e5);

function destination(value) {
    const address = value && value.address;
    const point = address && (address.optionPOILocation || address.optionLocation || address.contactLocation);
    if (!validPoint(point) || point.coordinatesValid !== true || typeof value.name !== 'string' ||
        !value.name.trim() || value.name.length > 140 || Buffer.byteLength(JSON.stringify(address)) > 24000) return;
    return { name: value.name, address, latitude: point.latitude, longitude: point.longitude };
}

function useAt(at, navigated, origin) {
    return { at, navigated, origin: validPoint(origin) ? { latitude: origin.latitude, longitude: origin.longitude } : null };
}

function limitHistory(history) {
    let bytes = 2;
    for (let i = 0; i < history.length; i++) {
        bytes += Buffer.byteLength(JSON.stringify(history[i])) + 1;
        if (i === maxDestinations || bytes > maxHistoryBytes) return history.slice(0, i);
    }
    return history;
}

function loadHistory(value, pending) {
    if (!Array.isArray(value)) return pending;
    const restored = new Map();
    value.slice(0, maxDestinations).forEach((row) => {
        const saved = destination(row);
        if (saved && Array.isArray(row.uses)) {
            saved.uses = row.uses.slice(-maxUses).filter((use) => use && Number.isSafeInteger(use.at) &&
                use.at > 0 && typeof use.navigated === 'boolean').map((use) => useAt(use.at, use.navigated, use.origin));
            const key = identity(saved);
            if (saved.uses.length && !restored.has(key)) restored.set(key, saved);
        }
    });
    const newest = pending.map((row) => {
        const key = identity(row), prior = restored.get(key);
        restored.delete(key);
        return prior ? Object.assign({}, row, { uses: prior.uses.concat(row.uses).slice(-maxUses) }) : row;
    });
    return limitHistory(newest.concat(Array.from(restored.values())));
}

function remember(history, selected, at, navigated, origin) {
    const saved = destination(selected);
    if (!saved) return history;
    const key = identity(saved);
    const prior = history.find((row) => identity(row) === key);
    const uses = prior ? prior.uses : [];
    const last = uses[uses.length - 1];
    if (last && last.navigated === navigated && at >= last.at && at - last.at < 60000) return history;
    saved.uses = uses.concat(useAt(at, navigated, origin)).slice(-maxUses);
    return limitHistory([saved].concat(history.filter((row) => identity(row) !== key)));
}

function timePattern(at, now) {
    const then = new Date(at);
    const weekday = (date) => date.getDay() > 0 && date.getDay() < 6;
    const minutes = (date) => date.getHours() * 60 + date.getMinutes();
    const difference = Math.abs(minutes(then) - minutes(now));
    const hours = Math.min(difference, 1440 - difference) / 60;
    const dayMatch = then.getDay() === now.getDay() ? 1 : weekday(then) === weekday(now) ? .7 : .2;
    return Math.exp(-Math.pow(hours / 2, 2)) * dayMatch;
}

function confidence(evidence) { return 1 - Math.exp(-evidence / 3); }

// Weights and decay match DestinationSuggestionEngine in BMWLauncher Android.
function score(uses, location, metres, now, favorite) {
    let recent = 0, frequency = 0, time = 0, origin = 0;
    const at = now.getTime();
    for (const use of uses) {
        if (use.at > at) continue;
        const age = (at - use.at) / day;
        const weight = use.navigated ? 1 : .35;
        const evidence = weight * Math.exp(-age / 60);
        recent = Math.max(recent, weight * Math.exp(-age / 14));
        frequency += evidence;
        const match = timePattern(use.at, now);
        if (use.navigated) time += evidence * match;
        if (location && use.origin) {
            const nearbyOrigin = Math.exp(-Math.pow(distance(location, use.origin) / 2000, 2));
            origin += evidence * nearbyOrigin * (.7 + .3 * match);
        }
    }
    const nearby = location ? 1 / (1 + metres / 20000) : 0;
    const originConfidence = confidence(origin);
    const relevance = location ? .35 + .65 * Math.max(nearby, originConfidence) : 1;
    return (recent * 25 + Math.min(1, Math.log1p(frequency) / Math.log1p(15)) * 20 + confidence(time) * 15) *
        relevance + originConfidence * 35 + nearby * 20 + (favorite ? 2 : 0);
}

function suggest(history, favorites, location, at) {
    const here = validPoint(location) ? location : null;
    const now = new Date(at);
    const distinct = new Map();
    history.forEach((row) => {
        const key = identity(row);
        if (!distinct.has(key)) distinct.set(key, { record: row, uses: row.uses, favorite: false });
    });
    favorites.forEach((value) => {
        const record = destination(value);
        if (!record) return;
        const key = identity(record), prior = distinct.get(key);
        distinct.set(key, { record, uses: prior ? prior.uses : [], favorite: true });
    });
    return Array.from(distinct.values()).map(({ record, uses, favorite }, order) => {
        const metres = here ? distance(here, record) : null;
        return { record, metres, score: score(uses, here, metres, now, favorite), order };
    }).filter((row) => row.metres === null || row.metres > 100)
        .sort((a, b) => b.score - a.score || a.order - b.order).slice(0, 3)
        .map(({ record, metres }) => ({ name: record.name, address: record.address, metres }));
}

module.exports = { loadHistory, remember, suggest };
