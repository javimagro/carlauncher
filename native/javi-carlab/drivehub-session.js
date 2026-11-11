'use strict';

const { Recorder } = require('./vendor/kit_record.js');
const { createDriveHub, width, height, viewport } = require('./drivehub-state.js');
const { createData, loadArtwork } = require('./drivehub-data.js');
const { drawHome } = require('./drivehub-view.js');

module.exports = function createSession(gpu, options) {
    const cv = new Recorder(width, height);
    const art = loadArtwork();
    let dirty = true;
    let shown = false;
    let area;
    let canGrab = false;
    let lastFrame = 0;
    let lastArticle;
    const panel = createDriveHub(() => { dirty = true; });
    const provider = createData(options, (field) => {
        if (field === 'news') {
            const articles = provider.data.news || [];
            const selected = articles.findIndex((item) => item.url === lastArticle);
            panel.setArticleCount(articles.length, selected < 0 ? 0 : selected);
        }
        dirty = true;
    });
    const data = provider.data;
    data.diagnostics = options.diagnostics;
    panel.setArticleCount((data.news || []).length);

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
        drawHome(cv, panel.state, panel.position(), data, art, now);
        gpu.frame(cv);
        lastFrame = now;
        dirty = false;
    }

    gpu.on('ready', (screen, info) => {
        const target = options.area(screen, info);
        if (!target) { gpu.show(false); return; }
        area = target;
        canGrab = !!info.controller;
        cv.textScale = area.scale;
        gpu.place(area);
        gpu.claim([viewport]);
        present();
    });
    gpu.on('touch', (phase, x, y) => { if (shown) panel.touch(phase, x, y); });
    gpu.on('ccu', (event) => { if (shown && canGrab) panel.controller(event); });
    gpu.on('closed', () => panel.resetInput());
    gpu.on('close', () => { area = undefined; panel.resetInput(); });
    gpu.on('state', (state) => { if (!state.onScreen) panel.resetInput(); });

    const timer = setInterval(() => {
        if (!shown || !area) return;
        const now = Date.now();
        provider.refresh(now);
        if (dirty || panel.animating() || now - lastFrame >= 900) frame(now);
    }, 33);

    return {
        telemetry(records) {
            data.telemetry = records;
            dirty = true;
        },
        controller(event) { if (shown && !canGrab) panel.controller(event); },
        show(on) {
            if (shown === on) return;
            shown = on;
            if (!on) data.telemetry = null;
            panel.resetInput();
            present();
        },
        close() {
            clearInterval(timer);
            provider.close();
            gpu.close();
        }
    };
};
