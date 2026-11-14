'use strict';
// Simulated BMW feedback, rendered by the production view; no car connection.
const fs = require('node:fs');
const path = require('node:path');
const { Recorder, play } = require('../emulator/split/software-renderer');
const { Canvas } = require('../native/javi-carlab/vendor/kit_canvas');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { createPreconditioningUI } = require('../native/javi-carlab/preconditioning-ui');
const output = path.resolve('dist/preconditioning-preview');
fs.mkdirSync(output, { recursive: true });
for (const theme of ['day', 'night']) for (const state of ['off', 'active', 'pending', 'unavailable', 'restricted', 'diagnostics']) {
    const ui = createPreconditioningUI(() => true, () => {});
    ui.receive({ available: state !== 'unavailable', active: state === 'active', mode: state === 'active' ? 1 : 0,
        restriction: 0, pending: false, requestId: null, result: null }, 1000);
    if (state === 'pending') ui.toggle(1000);
    if (state === 'restricted') {
        let sent; const failing = createPreconditioningUI((c) => { sent = c; return true; }, () => {});
        failing.receive({ available: true, active: false, mode: 0, restriction: 0, pending: false, requestId: null, result: null }, 1000);
        failing.toggle(1000); failing.receive({ available: true, active: false, mode: 0, restriction: 4, pending: false, requestId: sent.id, result: 'restricted' }, 1001);
        render(theme, state, failing); continue;
    }
    render(theme, state, ui);
}
function render(theme, state, ui) {
    const data = { telemetry: [], preconditioning: ui, diagnostics: state === 'diagnostics', home: 'ready',
        navigation: { state: 'inactive', points: [], destinations: [], segments: [], theme },
        energy: [{ label: 'Ahora' }, { label: 'En la parada' }, { label: 'Tras recarga' }, { label: 'En destino' }] };
    const cv = new Recorder(1960, 520), surface = new Canvas(1960, 520);
    drawHome(cv, { selected: 0, article: 0 }, 0, data, {}, 1001); play(cv.words(), surface);
    fs.writeFileSync(path.join(output, theme + '-' + state + '.png'), surface.png(6));
}
console.log('12 capturas con estados simulados del botón HV: ' + output);
