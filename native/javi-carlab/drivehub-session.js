'use strict';

const { Recorder } = require('./vendor/kit_record.js');
const { createDriveHub, width, height, viewport, cards, home, contains } = require('./drivehub-state.js');
const { createData, loadArtwork } = require('./drivehub-data.js');
const { drawHome } = require('./drivehub-view.js');
const { createTdt } = require('./tdtworld.js');
const { createPlayer } = require('./tdt-player.js');
const { createIsolatedPlayer } = require('./tdt-process.js');
const { createPhotoLoader } = require('./photo-loader.js');
const { createRadioUI } = require('./radio-ui.js');
const { createNavigation } = require('./navigation-model.js');
const { actionAt } = require('./navigation-view.js');
const { createNavigationUI } = require('./navigation-ui');
const { vehicleReadings } = require('./vehicle-readings');

module.exports = function createSession(gpu, options) {
    const photos = createPhotoLoader();
    options = Object.assign({}, options, { photo: photos.load });
    const cv = new Recorder(width, height);
    const art = loadArtwork();
    let dirty = true;
    let shown = false;
    let area;
    let canGrab = false;
    let onScreen = true;
    let touchAvailable = false;
    let confirmedOnScreen = false;
    let homeGesture;
    let mapGesture;
    const navigation = createNavigation();
    const navigationUi = createNavigationUI(options, () => { dirty = true; });
    let lastFrame = 0;
    let lastArticle;
    let cockpit;
    const player = options.tdtPlayback && (options.tdtPlayback.preview ? createPlayer : createIsolatedPlayer)(gpu, options.tdtPlayback);
    const tdt = createTdt(Object.assign({}, options, { tdtPlayer: player }), () => { dirty = true; });
    const radio = createRadioUI(options, () => { dirty = true; });
    const panel = createDriveHub(() => { dirty = true; }, Date.now, tdt, radio);
    const provider = createData(options, (field) => {
        if (field === 'news') {
            const articles = provider.data.news || [];
            const selected = articles.findIndex((item) => item.url === lastArticle);
            panel.setArticleCount(articles.length, selected < 0 ? 0 : selected);
        }
        dirty = true;
    });
    const data = provider.data;
    data.tdt = tdt;
    data.radio = radio;
    data.diagnostics = options.diagnostics;
    data.altitudeHistory = { values: [] };
    data.mapZoom = 1;
    data.navigationUi = navigationUi;
    panel.setArticleCount((data.news || []).length);

    function reportScreen() {
        if (options.onCaptureScreen) options.onCaptureScreen(!!(shown && area && touchAvailable && confirmedOnScreen));
    }

    function present() {
        if (!area) return;
        if (shown) frame(Date.now());
        gpu.show(shown);
        if (canGrab) gpu.grab(shown);
    }

    function frame(now) {
        if (panel.state.selected === 3) {
            const item = data.news && data.news[panel.state.article];
            lastArticle = item && item.url;
            provider.showPhoto(item && item.image);
        }
        cv.reset();
        data.navigation = navigation.snapshot(now);
        const records = data.telemetry && new Map(data.telemetry.map((row) => [row.signal, row]));
        navigationUi.update(data.navigation, vehicleReadings(records, now), shown && onScreen && !data.diagnostics);
        if (options.loadCockpit) data.cockpitStatus = cockpit ? cockpit.status(now) : 'Falta Cluster renderer';
        if (player && player.stats) data.playbackStats = player.stats();
        const readings = drawHome(cv, panel.state, panel.position(), data, art, now);
        gpu.frame(cv);
        if (cockpit && onScreen) cockpit.update(readings, now);
        lastFrame = now;
        dirty = false;
    }

    gpu.on('ready', (screen, info) => {
        const target = options.area(screen, info);
        if (!target) { area = undefined; hidden(); gpu.show(false); return; }
        area = target;
        onScreen = true;
        confirmedOnScreen = false;
        touchAvailable = !!info.touch;
        reportScreen();
        if (player) player.ready(info);
        canGrab = !!info.controller && !options.useOap;
        cv.textScale = area.scale;
        gpu.place(area);
        gpu.claim(options.onExit ? [{ x: 0, y: 0, w: width, h: height }] : [viewport]);
        present();
    });
    gpu.on('touch', (phase, x, y) => {
        if (!shown || !onScreen) return;
        const rawAction = actionAt(x, y, data.diagnostics, data.navigation);
        const action = rawAction === 'toggle' ? rawAction : null;
        if (phase === 'down') mapGesture = action ? { action, valid: true } : null;
        if (mapGesture) {
            if (action !== mapGesture.action) mapGesture.valid = false;
            if (phase === 'up' || phase === 'cancel') {
                const chosen = phase === 'up' && mapGesture.valid && mapGesture.action;
                mapGesture = null;
                if (chosen === 'toggle') data.diagnostics = !data.diagnostics;
                else if (chosen === 'fit') data.mapZoom = 1;
                else if (chosen === 'zoom-in') data.mapZoom = Math.min(4, data.mapZoom * 1.5);
                else if (chosen === 'zoom-out') data.mapZoom = Math.max(0.5, data.mapZoom / 1.5);
                if (chosen) dirty = true;
            }
            return;
        }
        if (!data.diagnostics && navigationUi.touch(phase, x, y)) return;
        if (phase === 'down') homeGesture = options.onExit && contains(home, x, y) ? { valid: true } : undefined;
        if (!homeGesture) { panel.touch(phase, x, y); return; }
        if (phase === 'move' && !contains(home, x, y)) homeGesture.valid = false;
        if (phase === 'up' || phase === 'cancel') {
            const activate = phase === 'up' && homeGesture.valid && contains(home, x, y);
            homeGesture = undefined;
            if (activate) options.onExit();
        }
    });
    function controller(event) {
        if (!data.diagnostics && !navigationUi.state.focused && panel.state.selected === 0 && [10, 11].includes(event.tilt)) navigationUi.focus();
        if (data.diagnostics || !navigationUi.controller(event)) panel.controller(event);
        else if (!navigationUi.state.focused) panel.resetInput();
    }
    gpu.on('ccu', (event) => { if (shown && canGrab) controller(event); });
    function hidden() {
        onScreen = false;
        confirmedOnScreen = false;
        homeGesture = undefined;
        mapGesture = null;
        navigationUi.reset();
        reportScreen();
        panel.resetInput();
        tdt.update(Date.now(), false);
        radio.update(Date.now(), false);
        if (cockpit) cockpit.close();
    }
    gpu.on('closed', hidden);
    gpu.on('close', () => { area = undefined; hidden(); });
    gpu.on('state', (state) => {
        if (state.onScreen && shown) {
            onScreen = true;
            confirmedOnScreen = true;
            reportScreen();
        }
        else hidden();
    });

    const timer = setInterval(() => {
        if (!shown || !area) return;
        const now = Date.now();
        provider.refresh(now);
        const radioCard = cards[1], radioX = viewport.x + radioCard.x - panel.position();
        radio.update(now, onScreen && radioX < viewport.x + viewport.w && radioX + radioCard.w > viewport.x);
        tdt.update(now, onScreen && cards[panel.state.selected].id === 'tdtworld');
        if (dirty || panel.animating() || now - lastFrame >= 900) frame(now);
    }, 33);

    return {
        navigation(frame) { navigation.receive(frame, Date.now()); dirty = true; },
        radio(frame) { radio.receive(frame, Date.now()); dirty = true; },
        setController(status) {
            if (data.controllerStatus !== status) { data.controllerStatus = status; dirty = true; }
        },
        setHome(status) {
            if (data.home === status) return;
            data.home = status;
            dirty = true;
        },
        telemetry(records) {
            data.telemetry = records;
            dirty = true;
        },
        controller(event) { if (shown && onScreen && !canGrab) controller(event); },
        show(on) {
            if (shown === on) return;
            shown = on;
            if (!on) {
                confirmedOnScreen = false;
                homeGesture = undefined;
                mapGesture = null;
                navigation.receive(null, Date.now());
                navigationUi.reset();
                data.telemetry = null;
                data.altitudeHistory = { values: [] };
                tdt.update(Date.now(), false);
                radio.update(Date.now(), false);
                radio.receive(null, Date.now());
                if (cockpit) cockpit.close();
            } else if (options.loadCockpit && !cockpit) cockpit = options.loadCockpit();
            panel.resetInput();
            reportScreen();
            present();
        },
        close() {
            hidden();
            clearInterval(timer);
            provider.close();
            photos.close();
            navigationUi.close();
            radio.close();
            tdt.close();
            gpu.close();
        }
    };
};
