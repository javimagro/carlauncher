'use strict';
// Simulated BMW feedback, rendered by the production view; no car connection.
const fs = require('node:fs');
const path = require('node:path');
const { Recorder, play } = require('../emulator/split/software-renderer');
const { Canvas } = require('../native/javi-carlab/vendor/kit_canvas');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { createPreconditioningUI } = require('../native/javi-carlab/preconditioning-ui');
const { width, height } = require('../native/javi-carlab/drivehub-state');
const output = path.resolve('dist/preconditioning-preview');
fs.mkdirSync(output, { recursive: true });
for (const theme of ['day', 'night']) for (const state of ['off', 'active', 'pending', 'unavailable', 'restricted', 'diagnostics']) {
    let toast, sent;
    const ui = createPreconditioningUI((command) => { sent = command; return true; }, () => {}, (message, now) => { toast = { message, until: now + 4000 }; });
    const feedback = { available: state !== 'unavailable', active: state === 'active', mode: state === 'active' ? 1 : 0,
        restriction: 0, pending: false, requestId: null, result: null };
    ui.receive(feedback, 1000);
    if (['pending', 'unavailable', 'restricted'].includes(state)) ui.toggle(1000);
    if (state === 'restricted') ui.receive(Object.assign({}, feedback, { restriction: 4, requestId: sent.id, result: 'restricted' }), 1001);
    render(theme, state, ui, toast);
}
function render(theme, state, ui, toast) {
    const data = { telemetry: [], preconditioning: ui, toast, diagnostics: state === 'diagnostics', home: 'ready',
        navigation: { state: 'inactive', points: [], destinations: [], segments: [], theme },
        energy: [{ label: 'Ahora' }, { label: 'En la parada' }, { label: 'Tras recarga' }, { label: 'En destino' }] };
    const cv = new Recorder(width, height), surface = new Canvas(width, height);
    drawHome(cv, { selected: 0, article: 0 }, 0, data, {}, 1001); play(cv.words(), surface);
    fs.writeFileSync(path.join(output, theme + '-' + state + '.png'), surface.png(6));
}
console.log('12 capturas con estados simulados del botón HV: ' + output);
