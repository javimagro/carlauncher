'use strict';

const path = require('node:path');
const [app, socket, kit, store] = process.argv.slice(2);
const record = require(path.join(kit, 'kit/runtime/record.js'));
const { RenderClient } = require(path.join(store, 'native/mgu-render/js/mgu_render_client.js'));
const { width, height, rightPanel, drawLauncher } = require('../launcher-view');

const launcher = app === 'launcher';
const bounds = launcher ? { x: 0, y: 0, w: width, h: height } : rightPanel;
const shortcut = { x: 16, y: 16, w: 64, h: 58 };
const stations = ['Radio 1', 'Radio 2', 'Radio 3'];
const rowHeight = 62;
const rowTop = 106;
let open = false;
let selected = 0;
let playing = -1;
let touches = 0;
let turns = 0;
let presses = 0;
let knob = 0;
let pressed = false;
const cv = new record.Recorder(bounds.w, bounds.h);
const gpu = new RenderClient(launcher ? 'javi_carlauncher_preview' : 'javi_panel_radio_demo', console, { socket, kit: record });

function draw() {
    cv.reset();
    if (launcher) {
        drawLauncher(cv, { external: open });
        cv.roundRect(shortcut.x, shortcut.y, shortcut.w, shortcut.h, 12, '#205577');
        cv.text(open ? 'Cerrar' : 'Radio', 48, 51, 16, '#f0f5fa', { align: 'center' });
    } else {
        cv.clear('#101a26');
        cv.text('Radio de prueba', 26, 50, 31, '#f0f5fa', { font: 'bold' });
        cv.text('App independiente · emisoras ficticias', 28, 81, 20, '#afc0cf');
        stations.forEach((name, i) => {
            const y = rowTop + i * rowHeight;
            cv.roundRect(24, y, bounds.w - 48, rowHeight - 6, 8, i === selected ? '#205577' : '#192836');
            cv.text(name, 40, y + 35, 25, '#f0f5fa');
            if (i === playing) cv.text('Confirmada', bounds.w - 144, y + 35, 20, '#a2e2b3');
        });
        cv.text('Toques: ' + touches + '    Giros: ' + turns + '    Pulsaciones: ' + presses, 28, 341, 22, '#afc0cf');
        cv.text('Toca una emisora o gira y pulsa la rueda', 28, 387, 20, '#afc0cf');
    }
    gpu.frame(cv);
}

gpu.on('ready', () => {
    gpu.place({ ...bounds, scale: 1 });
    gpu.claim([launcher ? shortcut : { x: 0, y: 0, w: bounds.w, h: bounds.h }]);
    draw();
    gpu.show(launcher || open);
    if (!launcher) gpu.grab(open);
});

gpu.on('touch', (phase, x, y) => {
    if (phase !== 'up') return;
    if (launcher) {
        if (x < shortcut.x || x >= shortcut.x + shortcut.w || y < shortcut.y || y >= shortcut.y + shortcut.h) return;
        open = !open;
        draw();
        process.send(open);
        return;
    }
    const row = Math.floor((y - rowTop) / rowHeight);
    if (row < 0 || row >= stations.length || x < 24 || x >= bounds.w - 24 || y >= rowTop + (row + 1) * rowHeight - 6) return;
    selected = playing = row;
    touches++;
    draw();
});

if (!launcher) {
    process.on('message', (visible) => {
        open = visible;
        gpu.show(open);
        gpu.grab(open);
    });
    gpu.on('ccu', (event) => {
        const delta = ((event.knob - knob + 32768) & 0xffff) - 32768;
        knob = event.knob;
        if (delta) {
            selected = ((selected + delta) % stations.length + stations.length) % stations.length;
            turns += Math.abs(delta);
        }
        if (event.press && !pressed) {
            playing = selected;
            presses++;
        }
        pressed = !!event.press;
        draw();
    });
}

process.on('disconnect', () => gpu.close());
gpu.connect();
