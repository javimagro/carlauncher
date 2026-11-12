'use strict';

const { Recorder } = require('./vendor/kit_record.js');
const { createDriveHub, width, height, viewport, cards, home, contains } = require('./drivehub-state.js');
const { createData, loadArtwork } = require('./drivehub-data.js');
const { drawHome } = require('./drivehub-view.js');
const { createTdt } = require('./tdtworld.js');
const { createPlayer } = require('./tdt-player.js');

module.exports = function createSession(gpu, options) {
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
    let lastFrame = 0;
    let lastArticle;
    let cockpit;
    const player = options.tdtPlayback && createPlayer(gpu, options.tdtPlayback);
    const tdt = createTdt(Object.assign({}, options, { tdtPlayer: player }), () => { dirty = true; });
    const panel = createDriveHub(() => { dirty = true; }, Date.now, tdt);
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
    data.diagnostics = options.diagnostics;
    data.altitudeHistory = { values: [] };
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
        if (options.loadCockpit) data.cockpitStatus = cockpit ? cockpit.status(now) : 'Falta Cluster renderer';
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
        if (phase === 'down') homeGesture = options.onExit && contains(home, x, y) ? { valid: true } : undefined;
        if (!homeGesture) { panel.touch(phase, x, y); return; }
        if (phase === 'move' && !contains(home, x, y)) homeGesture.valid = false;
        if (phase === 'up' || phase === 'cancel') {
            const activate = phase === 'up' && homeGesture.valid && contains(home, x, y);
            homeGesture = undefined;
            if (activate) options.onExit();
        }
    });
    gpu.on('ccu', (event) => { if (shown && canGrab) panel.controller(event); });
    function hidden() {
        onScreen = false;
        confirmedOnScreen = false;
        homeGesture = undefined;
        reportScreen();
        panel.resetInput();
        tdt.update(Date.now(), false);
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
        tdt.update(now, onScreen && cards[panel.state.selected].id === 'tdtworld');
        if (dirty || panel.animating() || now - lastFrame >= 900) frame(now);
    }, 33);

    return {
        setHome(status) {
            if (data.home === status) return;
            data.home = status;
            dirty = true;
        },
        telemetry(records) {
            data.telemetry = records;
            dirty = true;
        },
        controller(event) { if (shown && onScreen && !canGrab) panel.controller(event); },
        show(on) {
            if (shown === on) return;
            shown = on;
            if (!on) {
                confirmedOnScreen = false;
                homeGesture = undefined;
                data.telemetry = null;
                data.altitudeHistory = { values: [] };
                tdt.update(Date.now(), false);
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
            tdt.close();
            gpu.close();
        }
    };
};
