'use strict';

const fs = require('fs');
const { valid } = require('./radio-model');
const filters = ['favorites', 'popular', 'music', 'sports'];
const empty = () => ({ stations: [], current: null, active: false, sourceKnown: false, loading: false, listError: '', result: null });
function createRadioUI(options, invalidate) {
    options = options || {}; invalidate = invalidate || (() => {});
    const state = { mode: 'playing', filters: [], index: 0, top: 0, filterFocus: -1, message: '', frame: empty() };
    const favorites = new Map(), images = new Map(), attempted = new Map(), decoding = new Set();
    let received = 0, serial = 0, pending = null, closed = false, writeBusy = false, writeAgain = false;
    let preferencesReady = !options.radioFile;
    let lastArt = '', lastLogo = '', artRequest, enabled = false, imageEpoch = 0;
    // Same decorative spectrum as DriveHub; these bars are NOT audio amplitude.
    let random = 0x51f15eed, tick = 0, lastAnimation = 0;
    const levels = Array(64).fill(.025), targets = levels.slice();
    function favorite(s) { return favorites.has(s.memoryKey) ? favorites.get(s.memoryKey) : s.favorite || s.list === 7; }
    function rows() {
        const all = new Map(), popular = new Set(), nativeFavorites = new Set();
        state.frame.stations.forEach((s) => { if (s.list === 10) popular.add(s.key); if (s.list === 7) nativeFavorites.add(s.key); });
        state.frame.stations.forEach((s) => { if (!all.has(s.key)) all.set(s.key, Object.assign({}, s, { favorite: s.favorite || nativeFavorites.has(s.key) })); });
        return Array.from(all.values()).filter((s) => (!state.filters.includes('favorites') || favorite(s)) &&
            (!state.filters.some((f) => f !== 'favorites') || state.filters.some((f) => f === s.category || f === 'popular' && popular.has(s.key))));
    }
    function clamp() {
        const length = rows().length; state.index = Math.max(0, Math.min(state.index, length - 1));
        state.top = Math.max(0, Math.min(state.top, Math.max(0, length - 4)));
        if (state.index < state.top) state.top = state.index;
        if (state.index >= state.top + 4) state.top = state.index - 3;
    }
    function send(op, station) {
        const id = 'r' + (++serial);
        if (!options.radioCommand || !options.radioCommand({ id, op, key: station && station.key, list: station && station.list })) {
            if (op !== 'artwork') state.message = 'Sin conexión con la radio BMW'; return null;
        }
        return id;
    }
    function tune(s) {
        if (!s || pending || !enabled) return;
        const id = send('tune', s);
        if (id) { pending = { id, at: Date.now() }; state.message = 'Sintonizando…'; }
        invalidate();
    }
    function save() {
        if (!options.radioFile) return;
        if (!preferencesReady) { writeAgain = true; return; }
        if (writeBusy) { writeAgain = true; return; }
        writeBusy = true;
        fs.writeFile(options.radioFile + '.tmp', JSON.stringify({ version: 1, favorites: Array.from(favorites.entries()).slice(-256) }), { mode: 0o600 }, (error) => {
            function done(err) {
                writeBusy = false; if (err && !closed) { state.message = 'No se pudieron guardar los favoritos'; invalidate(); }
                if (writeAgain) { writeAgain = false; save(); }
            }
            if (error) done(error); else fs.rename(options.radioFile + '.tmp', options.radioFile, done);
        });
    }
    function preferencesLoaded() {
        preferencesReady = true;
        if (writeAgain) { writeAgain = false; save(); }
    }
    if (options.radioFile) fs.stat(options.radioFile, (error, info) => {
        if (error || info.size > 128 * 1024 || closed) { preferencesLoaded(); return; }
        fs.readFile(options.radioFile, 'utf8', (err, raw) => {
            if (err || closed) { preferencesLoaded(); return; }
            try {
                const p = JSON.parse(raw);
                if (p.version === 1 && Array.isArray(p.favorites)) p.favorites.slice(-256).forEach((pair) => {
                    if (Array.isArray(pair) && typeof pair[0] === 'string' && pair[0].length <= 110 && typeof pair[1] === 'boolean' && !favorites.has(pair[0]) && favorites.size < 256) favorites.set(pair[0], pair[1]);
                });
                clamp(); invalidate();
            } catch (_) { /* A malformed preference file must not stop the tuner. */ }
            preferencesLoaded();
        });
    });
    function toggleFavorite(s) {
        if (!s) return; const value = !favorite(s); favorites.delete(s.memoryKey); favorites.set(s.memoryKey, value);
        if (favorites.size > 256) favorites.delete(favorites.keys().next().value);
        state.message = value ? 'Añadida a favoritos de BMWLauncher' : 'Quitada de favoritos de BMWLauncher';
        clamp(); save(); invalidate();
    }
    function filter(index) {
        const name = filters[index], at = state.filters.indexOf(name);
        if (at < 0) state.filters.push(name); else state.filters.splice(at, 1);
        state.index = state.top = 0; invalidate();
    }
    function image(p) {
        if (!p || !p.bytes || !options.photo || decoding.has(p.key)) return;
        const epoch = imageEpoch;
        decoding.add(p.key);
        options.photo('https://radio.invalid/' + p.key, () => Promise.resolve(Buffer.from(p.bytes, 'base64')), 160, 160, true,
            () => !closed && enabled && epoch === imageEpoch).then((img) => {
                if (closed || !enabled || epoch !== imageEpoch) return;
                images.delete(p.key); images.set(p.key, img);
                if (images.size > 20) images.delete(images.keys().next().value);
                invalidate();
            }, () => {}).then(() => decoding.delete(p.key));
    }
    function receive(frame, now) {
        if (closed) return;
        const selected = rows()[state.index];
        if (!frame || !valid(frame)) { state.frame = empty(); received = 0; images.clear(); imageEpoch++; invalidate(); return; }
        state.frame = frame; received = now;
        if (selected) { const index = rows().findIndex((s) => s.key === selected.key); if (index >= 0) state.index = index; }
        clamp();
        if (pending && frame.result && frame.result.id === pending.id && frame.result.ok !== null) {
            state.message = frame.result.message;
            if (frame.result.ok) { state.mode = 'playing'; state.filterFocus = -1; }
            pending = null;
        }
        if (enabled) {
            if (frame.logo && frame.logo.key + ':' + frame.logo.serial !== lastLogo) {
                lastLogo = frame.logo.key + ':' + frame.logo.serial; image(frame.logo);
            }
            if (frame.artwork && frame.artwork.key + ':' + frame.artwork.serial !== lastArt) {
                lastArt = frame.artwork.key + ':' + frame.artwork.serial; image(frame.artwork);
                if (artRequest && artRequest.key === frame.artwork.key) artRequest = null;
            }
        }
        invalidate();
    }
    function update(now, visible) {
        if (closed) return;
        if (enabled !== visible) { enabled = visible; imageEpoch++; if (!enabled) { levels.fill(.025); lastLogo = lastArt = ''; } }
        if (received && now - received >= 5000) { state.frame = empty(); received = 0; invalidate(); }
        if (pending && now - pending.at > 18000) { pending = null; state.message = 'BMW no ha confirmado la emisora'; invalidate(); }
        if (!enabled) return;
        if (artRequest && now - artRequest.at > 10000) artRequest = null;
        if (!artRequest && !pending && !state.frame.artworkBusy) {
            const candidates = state.mode === 'list' ? rows().slice(state.top, state.top + 4) : [state.frame.current].filter(Boolean);
            const next = candidates.find((s) => !images.has(s.key) && !decoding.has(s.key) && (!attempted.has(s.key) || now - attempted.get(s.key) > 60000));
            if (next) { attempted.set(next.key, now); if (attempted.size > 128) attempted.delete(attempted.keys().next().value); if (send('artwork', next)) artRequest = { key: next.key, at: now }; }
        }
        if (state.mode !== 'playing' || now - lastAnimation < 50) return;
        lastAnimation = now;
        if (!state.frame.active || !state.frame.current || state.frame.current.receptionLost) { levels.fill(.025); return; }
        if (++tick % 2 === 0) targets.forEach((_, i) => {
            random ^= random << 13; random ^= random >>> 17; random ^= random << 5;
            const unit = (random & 0x7fffffff) / 0x7fffffff;
            targets[i] = .025 + .975 * Math.pow(unit, 3) * (1 - i / 64 * .2);
        });
        levels.forEach((value, i) => { levels[i] = value + (targets[i] - value) * .46; }); invalidate();
    }
    function open() { state.mode = 'list'; state.filterFocus = -1; clamp(); invalidate(); }
    return { state, rows, favorite, levels, images, receive, update, open, filter, toggleFavorite,
        rotate(delta) {
            if (state.mode !== 'list') { open(); return; }
            if (state.filterFocus >= 0) state.filterFocus = Math.max(0, Math.min(3, state.filterFocus + delta));
            else { state.index += delta; clamp(); } invalidate();
        },
        press(long) {
            if (state.mode !== 'list') { if (long) toggleFavorite(state.frame.current); else open(); }
            else if (state.filterFocus >= 0) filter(state.filterFocus);
            else if (long) toggleFavorite(rows()[state.index]); else tune(rows()[state.index]);
        },
        tilt(direction) {
            if (direction === 'left') { if (state.mode === 'list') { state.mode = 'playing'; state.filterFocus = -1; invalidate(); return true; } return false; }
            if (direction === 'right') return false;
            if (state.mode !== 'list') open();
            else if (direction === 'up') state.filterFocus = 0;
            else state.filterFocus = -1;
            invalidate(); return true;
        },
        touch(x, y, w, h, swipe) {
            if (swipe) { open(); state.index += swipe; clamp(); invalidate(); return; }
            if (state.mode === 'list') {
                if (y >= 48 && y < 104) { filter(Math.max(0, Math.min(3, Math.floor((x - 16) * 4 / (w - 32))))); return; }
                if (y >= 112 && y < 448) {
                    state.index = state.top + Math.floor((y - 112) / 84); clamp();
                    if (x > w - 60) toggleFavorite(rows()[state.index]); else tune(rows()[state.index]);
                } else if (y >= h - 54) { if (x < w / 2) { state.mode = 'playing'; invalidate(); } else send('refresh'); }
            } else if (y >= 175 && y < 350) tune(state.frame.current);
            else if (y >= h - 54 && x > w - 65) toggleFavorite(state.frame.current);
            else open();
            invalidate();
        },
        close() { closed = true; enabled = false; imageEpoch++; images.clear(); }
    };
}
module.exports = { createRadioUI, filters };
