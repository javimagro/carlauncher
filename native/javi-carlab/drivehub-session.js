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
const { createTripHistory } = require('./trip-history');
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
    let cockpitRetryAt = 0;
    let cockpitPending = false;
    let cockpitFocusUntil = 0;
    let cockpitFocusSent = false;
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
    const tripHistory = createTripHistory(options.tripHistoryFile);
    data.altitudeHistory = tripHistory;
    data.navigationUi = navigationUi;
    data.preconditioning = preconditioning;
    data.aaUi = aa;
    let telemetryRecords;
    const currentVehicle = (now = Date.now()) => vehicleReadings(telemetryRecords, now);
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

    function focusCockpit(now) {
        if (now >= cockpitFocusUntil) { cockpitFocusUntil = 0; return; }
        if (!shown || !area || !confirmedOnScreen || !cockpit) return;
        const result = cockpit.requestFocus();
        if (result === 'waiting') return;
        cockpitFocusSent = result === 'sent';
        cockpitFocusUntil = 0;
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
        const vehicle = currentVehicle(now);
        data.tripSummary = tripHistory.snapshot(vehicle, now);
        if (shown && onScreen) provider.refresh(now, vehicle.location);
        assistant.setVisible(shown && onScreen);
        if (aa) aa.update(shown && onScreen && confirmedOnScreen && touchAvailable && !!area,
            data.diagnostics, navigationUi.state.panel === 'none');
        navigationUi.update(data.navigation, vehicle, shown && onScreen && !data.diagnostics && (!aa || aa.state.source === 'bmw'));
        if (options.loadCockpit) data.cockpitStatus = cockpit ? cockpit.status(now) : 'Falta Cluster renderer';
        if (player && player.stats) data.playbackStats = player.stats();
        drawHome(cv, panel.state, panel.position(), data, art, now);
        gpu.frame(cv);
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
    function suspend(exiting) {
        if (exiting || confirmedOnScreen) cockpitFocusUntil = 0;
        if (cockpitFocusSent) cockpit.cancelFocus();
        cockpitFocusSent = false;
        data.toast = undefined;
        assistant.setVisible(false);
        provider.suspend(cockpit && cockpit.visible());
        confirmedOnScreen = false;
        homeGesture = undefined;
        mapGesture = null;
        if (aa) aa.update(false, data.diagnostics, false);
        navigationUi.reset(exiting);
        preconditioning.reset();
        reportScreen();
        panel.resetInput();
        tdt.update(Date.now(), false);
        radio.update(Date.now(), false);
    }
    function hidden() { onScreen = false; suspend(); }
    gpu.on('closed', hidden);
    gpu.on('close', () => { area = undefined; hidden(); });
    gpu.on('state', (state) => {
        if (state.onScreen && shown) {
            onScreen = true;
            confirmedOnScreen = true;
            reportScreen();
            focusCockpit(Date.now());
        }
        else hidden();
    });

    const timer = setInterval(() => {
        if (!shown || !area || !onScreen) return;
        const now = Date.now();
        if (data.toast && now >= data.toast.until) { data.toast = undefined; dirty = true; }
        const radioCard = cards[1], radioX = viewport.x + radioCard.x - panel.position();
        const tdtSelected = cards[panel.state.selected].id === 'tdtworld';
        tdt.update(now, onScreen && tdtSelected);
        radio.update(now, onScreen && radioX < viewport.x + viewport.w && radioX + radioCard.w > viewport.x,
            onScreen && confirmedOnScreen && !tdtSelected);
        const newsLoading = onScreen && cards[panel.state.selected].id === 'news' && data.photoStatus === 'loading';
        const voiceIndicator = onScreen && !data.diagnostics && navigationUi.state.panel === 'none' && assistant.state.indicator;
        if (dirty || panel.animating() || now - lastFrame >= (voiceIndicator ? 50 : newsLoading ? 240 : 900)) frame(now);
    }, 33);

    // The head unit starts this service before the central surface is opened.
    function updateBackground() {
        const now = Date.now();
        if (!cockpit && options.loadCockpit && !cockpitPending && now >= cockpitRetryAt) {
            cockpitRetryAt = now + 5000;
            cockpitPending = true;
            options.loadCockpit().then(client => {
                if (closing) { if (client) client.close(); return; }
                cockpit = client;
                if (client) updateBackground();
            }, () => {}).then(() => { cockpitPending = false; });
        }
        const vehicle = currentVehicle(now);
        if (!shown || !onScreen || !area) provider.refresh(now, vehicle.location, false, !!(cockpit && cockpit.visible()));
        if (cockpit) cockpit.update(vehicle, now, provider.weatherSnapshot(now));
        focusCockpit(now);
        if (options.onCockpitVisible) options.onCockpitVisible(!!(cockpit && cockpit.visible()));
    }
    const background = setInterval(updateBackground, 1000);
    updateBackground();

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
            telemetryRecords = records && new Map(records.map(row => [row.signal, row]));
            const now = Date.now();
            tripHistory.sample(currentVehicle(now), now);
            if (shown && onScreen) preconditioning.receive(thermal, now);
            dirty = true;
        },
        controller(event) { if (shown && onScreen && !canGrab) controller(event); },
        show(on, enteringLauncher) {
            if (closing || shown === on) return;
            shown = on;
            if (!on) {
                suspend(true);
                radio.receive(null, Date.now());
            } else {
                if (enteringLauncher && options.loadCockpit) cockpitFocusUntil = Date.now() + 5000;
                radio.beginVisibility();
            }
            panel.resetInput();
            reportScreen();
            present();
        },
        close() {
            if (closing) return closing;
            hidden();
            clearInterval(timer);
            clearInterval(background);
            if (cockpit) cockpit.close();
            provider.close();
            photos.close();
            navigationUi.close();
            assistant.close();
            radio.close();
            tdt.close();
            closing = Promise.all([aa && aa.close(), tripHistory.close()]);
            gpu.close();
            return closing;
        }
    };
};
