'use strict';

const layout = require('./layout.js');
const { rightPanel } = require('./launcher-view.js');
const record = require('./vendor/kit_record.js');
const { RenderClient } = require('/var/opt/mgu-render/current/mgu_render_client.js');

module.exports = function radio() {
    const { w, h } = rightPanel;
    const stations = ['Radio 1', 'Radio 2', 'Radio 3'];
    const cv = new record.Recorder(w, h);
    const gpu = new RenderClient('javi_panel_radio', console, { kit: record });
    const rowTop = 106;
    const rowHeight = 62;
    let selected = 0;
    let confirmed = -1;
    let touches = 0;
    let turns = 0;
    let presses = 0;
    let visible = false;
    let usable = false;
    let dirty = true;
    let down = -1;
    let lastFrame = 0;

    function select(row, confirm, fromTouch) {
        if (!visible) return;
        if (fromTouch) touches++;
        else if (selected !== row && !confirm) turns++;
        else if (confirm) presses++;
        selected = row;
        if (confirm) confirmed = row;
        dirty = true;
    }

    function rowAt(x, y) {
        const row = Math.floor((y - rowTop) / rowHeight);
        return row >= 0 && row < stations.length && x >= 24 && x < w - 24 && y < rowTop + (row + 1) * rowHeight - 6 ? row : -1;
    }

    gpu.on('ready', (screen, info) => {
        usable = !!info && info.modes.indexOf('layer') >= 0 && screen.w === 2880 && screen.h === 960;
        if (!usable) { gpu.show(false); return; }
        const area = layout(info.appArea).radio;
        cv.textScale = area.scale;
        gpu.place(area);
        gpu.claim([{ x: 0, y: 0, w, h }]);
        gpu.show(visible);
        dirty = true;
    });
    gpu.on('touch', (phase, x, y) => {
        const row = rowAt(x, y);
        if (phase === 'down') down = row;
        if (phase === 'up' && row >= 0 && row === down) select(row, true, true);
    });
    gpu.on('closed', () => { down = -1; });

    // La rueda se queda en el HMI. Los botones RHMI pertenecen a esta app y entregan foco y pulsación.
    const timer = setInterval(() => {
        if (!visible || !usable || (!dirty && Date.now() - lastFrame < 1000)) return;
        cv.reset();
        cv.clear('#101a26');
        cv.text('Radio de prueba', 26, 50, 31, '#f0f5fa', { font: 'bold' });
        cv.text('App independiente | emisoras ficticias', 28, 81, 20, '#afc0cf');
        stations.forEach((name, row) => {
            const y = rowTop + row * rowHeight;
            cv.roundRect(24, y, w - 48, rowHeight - 6, 8, selected === row ? '#205577' : '#192836');
            cv.text(name, 40, y + 35, 25, '#f0f5fa');
            if (confirmed === row) cv.text('Confirmada', w - 144, y + 35, 20, '#a2e2b3');
        });
        cv.text('Toques: ' + touches + '    Giros: ' + turns + '    Pulsaciones: ' + presses, 28, 341, 22, '#afc0cf');
        cv.text('Toca una emisora o gira y pulsa la rueda', 28, 387, 20, '#afc0cf');
        gpu.frame(cv);
        lastFrame = Date.now();
        dirty = false;
    }, 100);
    gpu.connect();

    return {
        bind(rhmi, truth) {
            stations.forEach((_, row) => {
                const button = rhmi.getByName('Station' + row);
                button.on('focus', (ev) => { if (truth(ev && ev.value)) select(row, false, false); });
                button.on('action', () => select(row, true, false));
            });
        },
        show(on) {
            visible = on;
            down = -1;
            if (usable) gpu.show(on);
            dirty = true;
        },
        close() { clearInterval(timer); gpu.close(); }
    };
};
