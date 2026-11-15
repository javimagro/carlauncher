'use strict';

const { Recorder } = require('./vendor/kit_record.js');
const { createDriveHub, width, height, viewport, cards, home, preconditioningButton, contains } = require('./drivehub-state.js');
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
const { createPreconditioningUI } = require('./preconditioning-ui');
const { createAssistant } = require('./assistant');
const { createCommands } = require('./assistant-drivehub');
const { createAAUI } = require('./aa-ui');

module.exports = function createSession(gpu, options) {
    const photos = createPhotoLoader();
    options = Object.assign({}, options, { photo: photos.load, notify });
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
    let closing;
    const navigation = createNavigation();
    const navigationUi = createNavigationUI(options, () => { dirty = true; });
    const preconditioning = createPreconditioningUI(options.preconditioningCommand, () => { dirty = true; }, notify);
    const aa = options.aa && createAAUI(options.aa, () => { dirty = true; }, notify, action => {
        if (action === 'diagnostics') data.diagnostics = true;
        else if (action === 'precondition') preconditioning.toggle(Date.now());
        else if (action === 'home' && options.onExit) options.onExit();
        dirty = true;
    });
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
    data.navigationUi = navigationUi;
    data.preconditioning = preconditioning;
    data.aaUi = aa;
    const currentVehicle = () => vehicleReadings(data.telemetry && new Map(data.telemetry.map((r) => [r.signal, r])), Date.now());
    const assistant = createAssistant(options, createCommands({ panel, radio, tdt, navigation: navigationUi, data,
        vehicle: currentVehicle, weather: () => provider.weatherSnapshot(Date.now()) }), () => { dirty = true; });
    navigationUi.assistant = assistant;
    panel.setArticleCount((data.news || []).length);

    function notify(message, now = Date.now()) {
        if (!shown || !onScreen || !message) return;
        data.toast = { message, until: now + 4000 };
        dirty = true;
    }

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
        if (shown && onScreen && panel.state.selected === 3) {
            const item = data.news && data.news[panel.state.article];
            lastArticle = item && item.url;
            provider.showPhoto(item && item.image);
        }
        cv.reset();
        data.navigation = navigation.snapshot(now);
        const records = data.telemetry && new Map(data.telemetry.map((row) => [row.signal, row]));
        const vehicle = vehicleReadings(records, now);
        provider.refresh(now, vehicle.location, shown && onScreen);
        assistant.setVisible(shown && onScreen);
        if (aa) aa.update(shown && onScreen && confirmedOnScreen && touchAvailable && !!area,
            data.diagnostics, navigationUi.state.panel === 'none');
        navigationUi.update(data.navigation, vehicle, shown && onScreen && !data.diagnostics && (!aa || aa.state.source === 'bmw'));
        if (options.loadCockpit) data.cockpitStatus = cockpit ? cockpit.status(now) : 'Falta Cluster renderer';
        if (player && player.stats) data.playbackStats = player.stats();
        const readings = drawHome(cv, panel.state, panel.position(), data, art, now);
        gpu.frame(cv);
        if (cockpit && onScreen) cockpit.update(readings, now, provider.weatherSnapshot(now));
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
        if (aa) aa.ready(info);
        canGrab = !!info.controller && !options.useOap;
        cv.textScale = area.scale;
        gpu.place(area);
        gpu.claim(options.onExit ? [{ x: 0, y: 0, w: width, h: height }] : [viewport]);
        present();
    });
    gpu.on('touch', (phase, x, y) => {
        if (!shown || !onScreen) return;
        const bmwControls = data.diagnostics || !aa || aa.state.source === 'bmw';
        const rawAction = bmwControls && actionAt(x, y, data.diagnostics, data.navigation);
        const action = bmwControls && contains(preconditioningButton, x, y) ? 'precondition' : rawAction === 'toggle' ? rawAction : null;
        if (phase === 'down') mapGesture = action ? { action, valid: true } : null;
        if (mapGesture) {
            if (action !== mapGesture.action) mapGesture.valid = false;
            if (phase === 'up' || phase === 'cancel') {
                const chosen = phase === 'up' && mapGesture.valid && mapGesture.action;
                mapGesture = null;
                if (chosen === 'toggle') data.diagnostics = !data.diagnostics;
                else if (chosen === 'precondition') preconditioning.toggle(Date.now());
                if (chosen) dirty = true;
            }
            return;
        }
        if (!data.diagnostics && aa && aa.touch(phase, x, y)) return;
        if (!data.diagnostics && (!aa || aa.state.source === 'bmw') && navigationUi.touch(phase, x, y)) return;
        if (phase === 'down') homeGesture = bmwControls && options.onExit && contains(home, x, y) ? { valid: true } : undefined;
        if (!homeGesture) { panel.touch(phase, x, y); return; }
        if (phase === 'move' && !contains(home, x, y)) homeGesture.valid = false;
        if (phase === 'up' || phase === 'cancel') {
            const activate = phase === 'up' && homeGesture.valid && contains(home, x, y);
            homeGesture = undefined;
            if (activate) options.onExit();
        }
    });
    function controller(event) {
        if (!data.diagnostics && aa && aa.controller(event)) {
            panel.trackInput(event); navigationUi.trackInput(event); return;
        }
        const navigationOwnsInput = !data.diagnostics && (!aa || aa.state.source === 'bmw') && navigationUi.state.panel !== 'none';
        if (event.skip) {
            if (!navigationOwnsInput) panel.skip(event.skip);
        } else if (navigationOwnsInput) {
            panel.trackInput(event);
            navigationUi.controller(event);
        } else {
            navigationUi.trackInput(event);
            panel.controller(event);
        }
    }
    gpu.on('ccu', (event) => { if (shown && onScreen && canGrab) controller(event); });
    function hidden() {
        data.toast = undefined;
        assistant.setVisible(false);
        provider.suspend();
        onScreen = false;
        confirmedOnScreen = false;
        homeGesture = undefined;
        mapGesture = null;
        if (aa) aa.update(false, data.diagnostics, false);
        navigationUi.reset();
        preconditioning.reset();
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
        if (data.toast && now >= data.toast.until) { data.toast = undefined; dirty = true; }
        const radioCard = cards[1], radioX = viewport.x + radioCard.x - panel.position();
        radio.update(now, onScreen && radioX < viewport.x + viewport.w && radioX + radioCard.w > viewport.x);
        tdt.update(now, onScreen && cards[panel.state.selected].id === 'tdtworld');
        const newsLoading = onScreen && cards[panel.state.selected].id === 'news' && data.photoStatus === 'loading';
        const voiceIndicator = onScreen && !data.diagnostics && navigationUi.state.panel === 'none' && assistant.state.indicator;
        if (dirty || panel.animating() || now - lastFrame >= (voiceIndicator ? 50 : newsLoading ? 240 : 900)) frame(now);
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
            if (status === 'error') notify('No se ha podido volver a iDrive');
            dirty = true;
        },
        telemetry(records, thermal) {
            data.telemetry = records;
            if (shown && onScreen) preconditioning.receive(thermal, Date.now());
            dirty = true;
        },
        controller(event) { if (shown && onScreen && !canGrab) controller(event); },
        show(on) {
            if (closing || shown === on) return;
            shown = on;
            if (!on) {
                data.toast = undefined;
                assistant.setVisible(false);
                provider.suspend();
                confirmedOnScreen = false;
                homeGesture = undefined;
                mapGesture = null;
                if (aa) aa.update(false, data.diagnostics, false);
                navigation.receive(null, Date.now());
                navigationUi.reset();
                preconditioning.reset();
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
            if (closing) return closing;
            hidden();
            clearInterval(timer);
            provider.close();
            photos.close();
            navigationUi.close();
            assistant.close();
            radio.close();
            tdt.close();
            closing = aa ? aa.close() : Promise.resolve();
            gpu.close();
            return closing;
        }
    };
};
