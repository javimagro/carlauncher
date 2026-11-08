'use strict';

const fs = require('fs');
const path = require('path');
const layout = require('./layout.js');
const { width, height, rightPanel, drawLauncher } = require('./launcher-view.js');
const record = require('./vendor/kit_record.js');
const { RenderClient } = require('/var/opt/mgu-render/current/mgu_render_client.js');

const launcherId = 'javi_carlauncher';
const radioId = 'javi_panel_radio';
const directory = '/var/opt/public/oap';
const shortcut = { x: 16, y: 16, w: 64, h: 58 };
const gpu = new RenderClient('javi_carlab_frame', console, { kit: record });
const cv = new record.Recorder(width, height);
let visible = '';
let origin;
let action = false;
let down = false;
let error = '';
let dirty = true;
let lastFrame = 0;
let usable = false;

const request = require('./hmi.js')('/var/opt/iteriodev-overlays/current/hmictl', (err) => {
    console.error(err.message);
    gpu.close();
    process.exit(1);
});

function installed() {
    const ids = {};
    for (const name of fs.readdirSync(directory)) {
        if (!/^oap_\d+$/.test(name)) continue;
        try {
            const app = JSON.parse(fs.readFileSync(path.join(directory, name, 'rhmiData', 'application.json'), 'utf8').replace(/^\uFEFF/, '')).application;
            if ((app.name === launcherId || app.name === radioId) && Number.isInteger(app.appletId)) ids[app.name] = app.appletId;
        } catch (err) { /* El directorio puede no tener página OAP. */ }
    }
    return ids;
}

function current(line) {
    const match = /^ok\s+(-?\d+)\s+(-?\d+)/.exec(line);
    return match ? { state: Number(match[1]), applet: Number(match[2]) } : null;
}

function matches(context, id) {
    return context && Number.isInteger(id) && (context.applet === id || context.applet === id + 3000);
}

async function openRadio(id) {
    await request('start ' + radioId);
    // La app en frío necesita registrar su estado antes de pedirlo al HMI.
    for (let attempt = 0; attempt < 3; attempt++) {
        for (const applet of [id, id + 3000]) {
            await request('open 1 ' + applet);
            const context = current(await request('ctx'));
            if (matches(context, id)) return true;
        }
        await new Promise((resolve) => setTimeout(resolve, 350));
    }
    return false;
}

async function poll() {
    try {
        const ids = installed();
        const context = current(await request('ctx'));
        const next = matches(context, ids[launcherId]) ? 'launcher' : origin && matches(context, ids[radioId]) ? 'radio' : '';
        if (!next) origin = null;
        if (next !== visible) {
            visible = next;
            dirty = true;
            gpu.show(usable && !!visible);
        }
        if (!action || !visible) return;
        action = false;
        error = '';
        if (visible === 'launcher') {
            if (!Number.isInteger(ids[radioId])) error = 'Instala Radio de prueba desde la Store';
            else {
                origin = context;
                if (!await openRadio(ids[radioId])) {
                    origin = null;
                    error = 'iDrive no ha abierto la radio';
                }
            }
        } else if (origin) {
            const result = await request('open ' + origin.state + ' ' + origin.applet);
            if (result === 'ok') origin = null;
        }
        if (error) console.warn(error);
        dirty = true;
    } catch (err) {
        console.warn(err.message);
        visible = '';
        origin = null;
        gpu.show(false);
    } finally {
        action = false;
        setTimeout(poll, 400);
    }
}

gpu.on('ready', (screen, info) => {
    usable = !!info && info.modes.indexOf('layer') >= 0 && screen.w === 2880 && screen.h === 960;
    if (!usable) {
        gpu.show(false);
        console.warn('CarLauncher requiere la salida ID8 de 2880 x 960 y el modo layer');
        return;
    }
    const area = layout(info.appArea).launcher;
    cv.textScale = area.scale;
    gpu.place(area);
    gpu.claim([
        { x: 0, y: 0, w: rightPanel.x, h: height },
        { x: rightPanel.x, y: rightPanel.y + rightPanel.h, w: width - rightPanel.x, h: height - rightPanel.y - rightPanel.h }
    ]);
    gpu.show(!!visible);
    dirty = true;
});
gpu.on('touch', (phase, x, y) => {
    const hit = x >= shortcut.x && x < shortcut.x + shortcut.w && y >= shortcut.y && y < shortcut.y + shortcut.h;
    if (phase === 'down') down = hit;
    if (phase !== 'up') return;
    if (down && hit) action = true;
    down = false;
});
gpu.on('closed', () => { down = false; });

setInterval(() => {
    if (!usable || !visible || (!dirty && Date.now() - lastFrame < 1000)) return;
    cv.reset();
    drawLauncher(cv, { external: visible === 'radio' });
    cv.roundRect(shortcut.x, shortcut.y, shortcut.w, shortcut.h, 12, '#205577');
    cv.text(visible === 'radio' ? 'Cerrar' : 'Radio', 48, 51, 16, '#f0f5fa', { align: 'center' });
    if (visible === 'launcher') cv.text(error || 'Toca Radio para abrir la segunda app', 912, 337, 24, '#afc0cf');
    gpu.frame(cv);
    lastFrame = Date.now();
    dirty = false;
}, 100);

gpu.connect();
poll();
