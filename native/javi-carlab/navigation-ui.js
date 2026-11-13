'use strict';

const fs = require('fs');
const { map, home, contains } = require('./drivehub-state');
const { createMap, world, geo, fit } = require('./navigation-map');
const directions = { 1: 'up', 2: 'up', 4: 'right', 5: 'right', 7: 'down', 8: 'down', 10: 'left', 11: 'left' };
function createNavigationUI(options, invalidate) {
    const tiles = createMap(options, invalidate);
    const state = { panel: 'none', query: '', keyboard: false, keyboardNumbers: false, focus: -1, offset: 0, buttons: [],
        focused: false, camera: null, follow: true, theme: 'auto', recent: [], favorites: [], savedTab: 'recent',
        preferences: { charging: true, arrival: 10, tolls: true, motorways: true }, message: '', nav: null, controls: null };
    let gesture, knob, press = false, tilt, request = 0, pending = 0, deadline = 0, on = false, closed = false, saving = false, saveAgain = false;
    let loadedState = !options.navigationFile, changedTheme = false;
    const validSaved = (s) => s && typeof s.name === 'string' && s.name.length <= 140 && s.address &&
        typeof s.address === 'object' && Buffer.byteLength(JSON.stringify(s.address)) <= 24000;
    function loaded(err, text) {
        if (closed) return;
        try {
            const saved = err ? {} : JSON.parse(text);
            if (Array.isArray(saved.recent)) state.recent = Array.from(new Set(state.recent.concat(saved.recent.filter((s) => typeof s === 'string' && s.length <= 140)))).slice(0, 12);
            if (Array.isArray(saved.favorites)) state.favorites = state.favorites.concat(saved.favorites.filter(validSaved)).slice(0, 12);
            if (!changedTheme && ['auto', 'day', 'night'].includes(saved.theme)) state.theme = saved.theme;
            invalidate();
        } catch (_) {}
        loadedState = true;
        if (saveAgain) { saveAgain = false; save(); }
    }
    if (options.navigationFile) fs.stat(options.navigationFile, (err, info) => {
        if (!err && info.size <= 512 * 1024) fs.readFile(options.navigationFile, 'utf8', loaded);
        else loaded(err || new Error('NAVIGATION_FILE_SIZE'));
    });
    function save() {
        if (!options.navigationFile) return;
        if (saving || !loadedState) { saveAgain = true; return; }
        saving = true;
        const content = JSON.stringify({ recent: state.recent, favorites: state.favorites, theme: state.theme });
        function done(error) {
            saving = false;
            if (error) { state.message = 'No se han podido guardar los destinos'; invalidate(); }
            if (saveAgain) { saveAgain = false; save(); }
        }
        fs.writeFile(options.navigationFile + '.tmp', content, { mode: 0o600 }, (err) => {
            if (err) done(err); else fs.rename(options.navigationFile + '.tmp', options.navigationFile, done);
        });
    }
    function send(action, extra) {
        if (pending || state.controls && state.controls.busy) { state.message = 'Espera a que termine BMW'; return; }
        request = Math.max(request + 1, Date.now());
        const command = Object.assign({ action, request }, extra);
        if (!options.navigationCommand || !options.navigationCommand(command)) { state.message = 'Sin conexión con navegación BMW'; return; }
        pending = request; deadline = Date.now() + 90000; state.message = '';
    }
    function search(query) {
        state.query = query.trim().slice(0, 140);
        if (!state.query) return;
        state.keyboard = false; state.offset = 0; state.focus = -1; state.panel = 'search';
        state.recent = [state.query].concat(state.recent.filter((s) => s !== state.query)).slice(0, 12); save();
        send('search', { query: state.query });
    }
    function activate(id) {
        state.focused = true; state.message = '';
        if (id === 'search') { state.panel = 'search'; state.keyboard = true; state.offset = 0; }
        else if (id === 'settings') { state.panel = 'settings'; state.keyboard = false; }
        else if (id === 'recent') { state.panel = 'recent'; state.keyboard = false; state.offset = 0; }
        else if (id === 'route-panel') { state.panel = 'route'; state.keyboard = false; send('itinerary'); }
        else if (id === 'chargers') { state.panel = 'search'; state.keyboard = false; state.offset = 0; send('chargers'); }
        else if (id === 'close') { state.panel = 'none'; state.keyboard = false; state.focus = -1; }
        else if (id === 'back') {
            if (state.keyboard) state.keyboard = false;
            else if (state.panel === 'detail') state.panel = 'search';
            else { state.panel = 'none'; state.focus = -1; }
        }
        else if (id === 'query') state.keyboard = !state.keyboard;
        else if (id === 'clear') state.query = '';
        else if (id === 'erase') state.query = state.query.slice(0, -1);
        else if (id === 'numbers') state.keyboardNumbers = !state.keyboardNumbers;
        else if (id === 'submit') search(state.query);
        else if (id.indexOf('key:') === 0 && state.query.length < 140) state.query += id.slice(4);
        else if (id.indexOf('history:') === 0) search(state.recent[Number(id.slice(8))] || '');
        else if (id === 'saved-recent' || id === 'saved-favorites') { state.savedTab = id === 'saved-recent' ? 'recent' : 'favorites'; state.offset = 0; }
        else if (id === 'save-destination') {
            const selected = state.controls && state.controls.selected;
            if (validSaved(selected)) {
                const encoded = JSON.stringify(selected.address), existing = state.favorites.findIndex((s) => JSON.stringify(s.address) === encoded);
                if (existing >= 0) state.favorites.splice(existing, 1);
                else if (state.favorites.length < 12) state.favorites.push({ name: selected.name, address: selected.address });
                else state.message = 'Ya tienes 12 destinos guardados';
                save();
            }
        }
        else if (id.indexOf('favorite:') === 0) {
            const bookmark = state.favorites[Number(id.slice(9))]; if (bookmark) send('restore', { bookmark });
        }
        else if (id.indexOf('result:') === 0) send('select', { id: id.slice(7) });
        else if (['route', 'add-stop', 'recalculate'].includes(id)) {
            state.panel = 'route'; state.keyboard = false; send(id, { preferences: state.preferences });
        } else if (id === 'start') send('start');
        else if (id === 'stop') { state.panel = 'stop'; state.keyboard = false; }
        else if (id === 'confirm-stop') send('stop');
        else if (id === 'page-up') state.offset = Math.max(0, state.offset - 4);
        else if (id === 'page-down') state.offset += 4;
        else if (id === 'fit') {
            const points = state.nav && state.nav.points.length ? state.nav.points : (state.controls && state.controls.stops || []).concat(state.location ? [state.location] : []);
            const fitted = fit(points); if (fitted) { state.camera = fitted; state.follow = false; }
        }
        else if (id === 'center') state.follow = true;
        else if (id === 'zoom-in' || id === 'zoom-out') {
            if (state.camera) state.camera.zoom = Math.max(3, Math.min(18, state.camera.zoom + (id === 'zoom-in' ? 1 : -1)));
        } else if (id === 'theme') { changedTheme = true; state.theme = ['auto', 'day', 'night'][(['auto', 'day', 'night'].indexOf(state.theme) + 1) % 3]; save(); }
        else if (id === 'arrival-up') state.preferences.arrival = Math.min(50, state.preferences.arrival + 5);
        else if (id === 'arrival-down') state.preferences.arrival = Math.max(5, state.preferences.arrival - 5);
        else if (id.indexOf('pref:') === 0) { const key = id.slice(5); if (['charging', 'tolls', 'motorways'].includes(key)) state.preferences[key] = !state.preferences[key]; }
        const keepFocus = id.indexOf('key:') === 0 || id.indexOf('pref:') === 0 ||
            ['erase', 'numbers', 'arrival-up', 'arrival-down', 'zoom-in', 'zoom-out', 'theme', 'save-destination'].includes(id);
        state.focus = keepFocus ? id : -1;
        invalidate();
    }
    function actionAt(x, y) { const b = state.buttons.find((button) => !button.disabled && contains(button, x, y)); return b && b.id; }
    function controller(event) {
        if (!state.focused) return false;
        const down = event.press === 1 || event.press === 2, direction = directions[event.tilt];
        if (knob !== undefined && event.knob !== 65535) {
            const delta = (event.knob - knob + 65535 + 32767) % 65535 - 32767;
            const buttons = state.buttons.filter((b) => !b.disabled);
            if (delta && Math.abs(delta) <= 64 && buttons.length) {
                const old = buttons.findIndex((b) => b.id === state.focus);
                state.focus = buttons[old < 0 ? delta > 0 ? 0 : buttons.length - 1 : (old + (delta > 0 ? 1 : -1) + buttons.length) % buttons.length].id;
            }
            if (!down && press && state.focus !== -1) activate(state.focus);
            if (direction && direction !== tilt) {
                if (direction === 'left') activate('back');
                else if (direction === 'right' && state.panel === 'none') state.focused = false;
                else if (direction === 'up' || direction === 'down') activate(direction === 'up' ? 'page-up' : 'page-down');
            }
        }
        if (event.knob !== 65535) knob = event.knob;
        press = down; tilt = direction; invalidate(); return true;
    }
    return {
        state, tiles, activate, controller,
        focus() { state.focused = true; knob = undefined; press = false; tilt = undefined; invalidate(); },
        update(nav, vehicle, visible) {
            state.nav = nav; on = visible;
            state.location = vehicle.location;
            const c = nav.controls;
            if (c) {
                if (pending && c.request >= pending) pending = 0;
                if (c !== state.controls && (!state.controls || c.request !== state.controls.request || c.status !== state.controls.status)) {
                    if (c.status === 'detail') {
                        state.panel = 'detail'; state.keyboard = false;
                        if (c.selected) { state.camera = Object.assign({}, c.selected, { zoom: 16 }); state.follow = false; }
                    }
                    if (c.status === 'preview') { state.panel = 'route'; const camera = fit(c.stops.concat(vehicle.location ? [vehicle.location] : [])); if (camera) { state.camera = camera; state.follow = false; } }
                    if (c.status === 'guiding' || c.status === 'idle') { state.panel = 'none'; if (c.status === 'guiding') { state.follow = true; if (state.camera) state.camera.zoom = 16; } }
                }
                state.controls = c;
            } else state.controls = null;
            if (pending && Date.now() > deadline) { pending = 0; state.message = 'BMW no ha respondido. Vuelve a intentarlo.'; }
            state.pending = !!pending;
            if (vehicle.location && (state.follow || !state.camera)) state.camera = Object.assign({}, vehicle.location, { zoom: state.camera ? state.camera.zoom : 16 });
            if (!state.camera && nav.points.length) state.camera = fit(nav.points);
            tiles.update(state.camera, on);
        },
        touch(phase, x, y) {
            if (contains(home, x, y) && !gesture) return false;
            if (phase === 'down') {
                if (!contains(map, x, y)) { state.focused = false; return false; }
                if (!state.focused) { knob = undefined; press = false; tilt = undefined; }
                state.focused = true;
                gesture = { x, y, action: actionAt(x, y), camera: state.camera && Object.assign({}, state.camera), valid: true };
            }
            if (!gesture) return false;
            const delta = Math.hypot(x - gesture.x, y - gesture.y);
            if (delta > 10) gesture.valid = false;
            if (phase === 'move' && !gesture.action && state.panel === 'none' && gesture.camera) {
                const w = world(gesture.camera, gesture.camera.zoom);
                state.camera = Object.assign(geo(w[0] - (x - gesture.x), w[1] - (y - gesture.y), gesture.camera.zoom), { zoom: gesture.camera.zoom });
                state.follow = false; invalidate();
            }
            if (phase === 'up' || phase === 'cancel') {
                if (phase === 'up' && gesture.valid && gesture.action === actionAt(x, y) && gesture.action) activate(gesture.action);
                else if (phase === 'up' && state.panel !== 'none' && Math.abs(y - gesture.y) > 40) activate(y < gesture.y ? 'page-down' : 'page-up');
                gesture = null;
            }
            return true;
        },
        reset() { gesture = null; knob = undefined; press = false; tilt = undefined; tiles.update(state.camera, false); },
        close() { closed = true; tiles.close(); }
    };
}
module.exports = { createNavigationUI };
