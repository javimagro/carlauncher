'use strict';

const fs = require('fs');
const { map, home, contains } = require('./drivehub-state');
const { createMap, world, geo, fit } = require('./navigation-map');
const layout = require('./navigation-layout');
const scene = require('./navigation-scene');
const assistantPanel = require('./assistant-panel');
const displayPanel = require('./navigation-displays');
const directions = { 1: 'up', 2: 'up', 4: 'right', 5: 'right', 7: 'down', 8: 'down', 10: 'left', 11: 'left' };
function createNavigationUI(options, invalidate) {
    const releaseIcons = require('./navigation-icons').preload(() => { if (!closed) invalidate(); });
    const tiles = createMap(options, invalidate);
    const state = { panel: 'none', query: '', cursor: 0, searchKind: 'text', keyboard: false, keyboardNumbers: false, focus: -1, offset: 0, buttons: [],
        focused: false, camera: null, follow: true, theme: 'auto', recent: [], favorites: [], savedTab: 'recent',
        preferences: { charging: true, arrival: 10, tolls: true, motorways: true }, message: '', nav: null, controls: null,
        stack: [], routePage: 'summary', addingStop: false };
    let gesture, knob, press = false, tilt, request = 0, pending = 0, deadline = 0, on = false, closed = false, saving = false, saveAgain = false;
    let loadedState = !options.navigationFile, changedTheme = false;
    let presentRequest = 0, cameraSignature = '', cameraRoute;
    let displayRequest = 0;
    function show(panel) {
        if (state.panel !== panel) {
            state.stack.push({ panel: state.panel, keyboard: state.keyboard, searchKind: state.searchKind,
                offset: state.offset, focus: state.focus, camera: state.camera, follow: state.follow, routePage: state.routePage, addingStop: state.addingStop });
            if (state.stack.length > 8) state.stack.shift();
        }
        state.panel = panel; state.keyboard = false; state.offset = 0; state.focus = -1;
    }
    function syncCamera(force) {
        if (!state.nav) return;
        if (state.panel === 'search' && !state.keyboard) state.offset = Math.max(0, Math.min(state.offset,
            Math.max(0, (state.controls && state.controls.results || []).length - layout.pageSize(state))));
        const fitPanel = state.panel === 'search' && !state.keyboard || state.panel === 'detail' || state.panel === 'route';
        // Geometry is owned by navigation-model and replaced when its encoding changes.
        // Compare its identity instead of serializing up to 12,000 points every frame.
        const route = state.panel === 'route' ? scene.routePoints(state) : null;
        const targets = !fitPanel ? [] : state.panel === 'route' ? scene.stops(state).concat(state.location || []) : scene.targets(state);
        const signature = fitPanel ? JSON.stringify([state.panel, state.offset, targets.map((p) => [p.latitude, p.longitude])]) : '';
        if (fitPanel && (force || route !== cameraRoute || signature !== cameraSignature)) scene.frame(state);
        else if (state.camera) state.camera = Object.assign({}, state.camera, { viewport: layout.viewport(state) });
        cameraSignature = signature; cameraRoute = route;
    }
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
        pending = request; state.pending = true; deadline = Date.now() + 90000; state.message = '';
        presentRequest = action === 'guidance-setting' ? 0 : request;
        if (action === 'guidance-setting') { displayRequest = request; state.displayFeedback = ''; }
        if (action === 'search' || action === 'chargers') state.controls = null;
    }
    function search(query) {
        state.query = query.trim().slice(0, 140); state.searchKind = 'text';
        state.cursor = state.query.length;
        if (!state.query) return;
        state.keyboard = false; state.offset = 0; state.focus = -1; state.panel = 'search';
        state.recent = [state.query].concat(state.recent.filter((s) => s !== state.query)).slice(0, 12); save();
        send('search', { query: state.query });
    }
    function activate(id) {
        state.focused = true; state.message = '';
        if (id === 'assistant') id = 'assistant:open';
        if ((id === 'close' && state.panel.indexOf('assistant') === 0 || id === 'back' && state.panel === 'assistant') && api.assistant) api.assistant.stop();
        if (id.indexOf('assistant:') === 0 && assistantPanel.action(api, id, show, invalidate)) { invalidate(); return; }
        if (id.indexOf('guidance-setting:') === 0) {
            const setting = id.slice('guidance-setting:'.length), data = state.nav && state.nav.presentation;
            if (on && !closed && displayPanel.settings.some((s) => s[0] === setting) && data && typeof data.options[setting] === 'boolean') {
                send('guidance-setting', { setting, enabled: !data.options[setting] });
            }
            invalidate(); return;
        }
        if (['back', 'close'].includes(id) && state.assistantEditor) { state.assistantEditor.draft = ''; state.assistantEditor = null; }
        const commandAction = ['chargers', 'submit', 'keyboard-done', 'route-panel', 'route', 'add-stop', 'recalculate', 'start', 'confirm-stop'].includes(id) ||
            id.indexOf('result:') === 0 || id.indexOf('favorite:') === 0 || id.indexOf('history:') === 0;
        if (commandAction && (pending || state.controls && state.controls.busy)) {
            state.message = 'Espera a que termine BMW'; invalidate(); return;
        }
        if (id === 'search' || id === 'add-stop-search') { show('search'); state.searchKind = 'text'; state.keyboard = true; state.cursor = state.query.length; state.addingStop = id === 'add-stop-search'; }
        else if (id === 'settings') show('settings');
        else if (id === 'route-settings') show('route-settings');
        else if (id === 'guidance-displays') show('guidance-displays');
        else if (id === 'recent') show('recent');
        else if (id === 'route-panel') { show('route'); state.routePage = 'summary'; send('itinerary'); }
        else if (id === 'chargers') { show('search'); state.searchKind = 'chargers'; send('chargers'); }
        else if (id === 'close') { presentRequest = 0; state.stack = []; state.panel = 'none'; state.keyboard = false; state.focus = -1; state.addingStop = false; }
        else if (id === 'back') {
            presentRequest = 0;
            if (state.panel === 'route' && state.routePage !== 'summary') { state.routePage = 'summary'; state.offset = 0; }
            else if (state.keyboard) state.keyboard = false;
            else if (state.stack.length) Object.assign(state, state.stack.pop());
            else { state.panel = 'none'; state.focus = -1; }
        }
        else if (id === 'query') { state.searchKind = 'text'; state.keyboard = true; state.cursor = state.query.length; }
        else if (id === 'keyboard-done') search(state.query);
        else if (id === 'clear') { state.query = ''; state.cursor = 0; }
        else if (id === 'erase' && state.cursor > 0) {
            state.query = state.query.slice(0, state.cursor - 1) + state.query.slice(state.cursor); state.cursor--;
        }
        else if (id === 'cursor-left') state.cursor = Math.max(0, state.cursor - 1);
        else if (id === 'cursor-right') state.cursor = Math.min(state.query.length, state.cursor + 1);
        else if (id === 'numbers') state.keyboardNumbers = !state.keyboardNumbers;
        else if (id === 'submit') search(state.query);
        else if (id.indexOf('key:') === 0 && state.query.length < 140) {
            state.query = state.query.slice(0, state.cursor) + id.slice(4) + state.query.slice(state.cursor); state.cursor += id.slice(4).length;
        }
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
            show('route');
            // Carlinkit returns from route preview to its result list, not a stale destination detail.
            if (state.stack.length && state.stack[state.stack.length - 1].panel === 'detail') state.stack.pop();
            state.routePage = 'summary'; send(id, { preferences: state.preferences });
        } else if (id === 'start') send('start');
        else if (id === 'stop') show('stop');
        else if (id === 'confirm-stop') send('stop');
        else if (id.indexOf('route-page:') === 0) { state.routePage = id.slice(11); state.offset = 0; }
        else if (id === 'page-up') state.offset = Math.max(0, state.offset - layout.pageSize(state));
        else if (id === 'page-down') state.offset += layout.pageSize(state);
        else if (id === 'fit') scene.frame(state);
        else if (id === 'center') { presentRequest = 0; state.panel = 'none'; state.stack = []; state.keyboard = false; state.follow = true; }
        else if (id === 'zoom-in' || id === 'zoom-out') {
            if (state.camera) state.camera.zoom = Math.max(3, Math.min(18, state.camera.zoom + (id === 'zoom-in' ? 1 : -1)));
        } else if (id === 'theme') { changedTheme = true; state.theme = ['auto', 'day', 'night'][(['auto', 'day', 'night'].indexOf(state.theme) + 1) % 3]; save(); }
        else if (id === 'arrival-up') state.preferences.arrival = Math.min(50, state.preferences.arrival + 5);
        else if (id === 'arrival-down') state.preferences.arrival = Math.max(5, state.preferences.arrival - 5);
        else if (id.indexOf('pref:') === 0) { const key = id.slice(5); if (['charging', 'tolls', 'motorways'].includes(key)) state.preferences[key] = !state.preferences[key]; }
        const keepFocus = id.indexOf('key:') === 0 || id.indexOf('pref:') === 0 || id.indexOf('result:') === 0 ||
            ['erase', 'clear', 'cursor-left', 'cursor-right', 'numbers', 'arrival-up', 'arrival-down', 'zoom-in', 'zoom-out', 'theme', 'save-destination'].includes(id);
        state.focus = keepFocus ? id : id === 'back' ? state.focus : -1;
        syncCamera();
        invalidate();
    }
    function actionAt(x, y) {
        const b = state.buttons.concat(tiles.status().ready ? scene.hits(state) : []).find((button) => !button.disabled && contains(button, x, y));
        return b && b.id;
    }
    function controller(event) {
        if (!state.focused) return false;
        const down = event.press === 1 || event.press === 2, direction = directions[event.tilt];
        if (knob !== undefined && event.knob !== 65535) {
            const delta = (event.knob - knob + 65535 + 32767) % 65535 - 32767;
            const buttons = state.buttons.filter((b) => !b.disabled);
            if (delta && Math.abs(delta) <= 64 && buttons.length) {
                const results = state.panel === 'search' && !state.keyboard && !state.pending && !(state.controls && state.controls.busy) ? state.controls && state.controls.results || [] : [];
                const first = buttons.findIndex((b) => b.id.indexOf('result:') === 0);
                const order = Array.from(new Set(buttons.filter((b) => b.id.indexOf('result:') !== 0).map((b) => b.id)));
                if (results.length) order.splice.apply(order, [first < 0 ? 0 : first, 0].concat(results.map((r) => 'result:' + r.id)));
                const old = order.indexOf(state.focus);
                state.focus = old < 0 && results.length ? 'result:' + results[Math.min(state.offset, results.length - 1)].id :
                    order[old < 0 ? delta > 0 ? 0 : order.length - 1 : (old + (delta > 0 ? 1 : -1) + order.length) % order.length];
                const index = results.findIndex((r) => 'result:' + r.id === state.focus), count = layout.pageSize(state);
                if (index >= 0) { if (index < state.offset) state.offset = index; else if (index >= state.offset + count) state.offset = index - count + 1; syncCamera(); }
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
    const api = {
        state, tiles, activate, controller, syncCamera,
        assistantSearch(query, chargers) {
            if (!on || closed || pending || state.controls && state.controls.busy) return { status: 'unavailable' };
            if (chargers) activate('chargers'); else search(query);
            invalidate(); return { status: pending ? 'requested' : 'error', message: 'Selecciona un resultado para ver y calcular su ruta' };
        },
        setTheme(theme) { if (['auto', 'day', 'night'].includes(theme)) { changedTheme = true; state.theme = theme; save(); invalidate(); } },
        focus() { state.focused = true; knob = undefined; press = false; tilt = undefined; invalidate(); },
        update(nav, vehicle, visible) {
            state.nav = nav; on = visible;
            state.location = vehicle.location;
            const c = nav.controls;
            if (c && (!pending || c.request >= pending)) {
                if (displayRequest && c.request >= displayRequest && !c.busy) {
                    if (c.request === displayRequest) state.displayFeedback = c.error || 'confirmed';
                    displayRequest = 0;
                }
                if (pending && c.request >= pending) pending = 0;
                if (c !== state.controls && (!state.controls || c.request !== state.controls.request || c.status !== state.controls.status)) {
                    if (presentRequest && c.request === presentRequest) {
                        if (c.status === 'detail') show('detail');
                        if (c.status === 'preview') { show('route'); state.routePage = 'summary'; state.addingStop = false;
                            if (c.plan) state.preferences.arrival = c.plan.arrival; }
                        if (c.status === 'guiding' || c.status === 'idle') {
                            state.panel = 'none'; state.stack = [];
                            if (c.status === 'guiding') { state.follow = true; if (state.camera) state.camera.zoom = 16; }
                        }
                    }
                }
                state.controls = c;
            } else if (!c) state.controls = null;
            if (pending && Date.now() > deadline) { pending = 0; state.message = 'BMW no ha respondido. Vuelve a intentarlo.'; }
            state.pending = !!pending;
            if (vehicle.location && (state.follow || !state.camera)) state.camera = Object.assign({}, vehicle.location, { zoom: state.camera ? state.camera.zoom : 16 });
            if (!state.camera && nav.points.length) state.camera = fit(nav.points);
            syncCamera();
            tiles.update(state.camera, on);
        },
        touch(phase, x, y) {
            if (contains(home, x, y) && !gesture) return false;
            if (phase === 'down') {
                if (!contains(map, x, y)) { state.focused = false; return false; }
                if (!state.focused) { knob = undefined; press = false; tilt = undefined; }
                state.focused = true;
                gesture = { x, y, action: actionAt(x, y), camera: state.camera && Object.assign({}, state.camera), valid: true,
                    list: state.panel !== 'none' && contains(layout.listBounds(state), x, y) };
            }
            if (!gesture) return false;
            const delta = Math.hypot(x - gesture.x, y - gesture.y);
            if (delta > 10) gesture.valid = false;
            if (phase === 'move' && !gesture.action && contains(layout.viewport(state), gesture.x, gesture.y) && tiles.status().ready && gesture.camera) {
                const w = world(gesture.camera, gesture.camera.zoom);
                state.camera = Object.assign(geo(w[0] - (x - gesture.x), w[1] - (y - gesture.y), gesture.camera.zoom), { zoom: gesture.camera.zoom, viewport: gesture.camera.viewport });
                state.follow = false; invalidate();
            }
            if (phase === 'up' || phase === 'cancel') {
                if (phase === 'up' && gesture.valid && gesture.action === actionAt(x, y) && gesture.action) activate(gesture.action);
                else if (phase === 'up' && gesture.list && Math.abs(y - gesture.y) > 40) activate(y < gesture.y ? 'page-down' : 'page-up');
                gesture = null;
            }
            return true;
        },
        reset() { gesture = null; knob = undefined; press = false; tilt = undefined; state.assistantEditor = null; if (state.panel === 'assistant-edit') state.panel = 'assistant-settings'; tiles.update(state.camera, false); },
        close() { closed = true; releaseIcons(); tiles.close(); }
    };
    return api;
}
module.exports = { createNavigationUI };
