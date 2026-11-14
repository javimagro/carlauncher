'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { Recorder, play } = require('../emulator/split/software-renderer');
const { Canvas } = require('../native/javi-carlab/vendor/kit_canvas');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { createNavigationUI } = require('../native/javi-carlab/navigation-ui');
const { createAssistant } = require('../native/javi-carlab/assistant');
const output = path.resolve('dist/assistant-preview'); fs.mkdirSync(output, { recursive: true });
async function main() {
    const ui = createNavigationUI({}, () => {}), assistant = createAssistant({}, async () => ({}));
    await assistant.ready; ui.assistant = assistant;
    await new Promise((resolve) => require('../native/javi-carlab/navigation-icons').preload(resolve));
    try {
        const nav = { state: 'inactive', points: [], destinations: [], segments: [], theme: 'night' };
        const data = { navigationUi: ui, navigation: nav, telemetry: [], diagnostics: false, home: 'ready',
            energy: [{ label: 'Ahora' }, { label: 'En la parada' }, { label: 'Tras recarga' }, { label: 'En destino' }] };
        let reference;
        const scenarios = ['settings', 'assistant-settings', 'assistant', 'assistant-edit', 'assistant-voices', 'assistant-save-error', 'assistant-saving'];
        for (const theme of ['day', 'night']) for (const panel of scenarios) {
            Object.assign(ui.state, { panel: panel.indexOf('assistant-sav') === 0 ? 'assistant-edit' : panel, theme, nav }); nav.theme = theme;
            ui.state.assistantEditor = { kind: 'key', draft: 'fake_value_for_masking_only', caps: true, numbers: false };
            if (panel === 'assistant-save-error') ui.state.assistantEditor.error = 'No se pudo guardar. Puedes volver a intentarlo.';
            if (panel === 'assistant-saving') ui.state.assistantEditor.saving = true;
            assistant.state.input = 'Pon Onda Cero'; assistant.state.answer = 'La radio BMW ha confirmado Onda Cero.'; assistant.state.message = '';
            assistant.state.config.configured.openai = true;
            const cv = new Recorder(1960, 520), canvas = new Canvas(1960, 520);
            drawHome(cv, { selected: 0, article: 0 }, 0, data, {}, 1000); play(cv.words(), canvas);
            if (!reference) reference = new Uint8Array(canvas.d);
            else for (let y = 0; y < 520; y++) {
                assert.deepEqual(canvas.d.subarray((y * 1960 + 1050) * 4, (y + 1) * 1960 * 4), reference.subarray((y * 1960 + 1050) * 4, (y + 1) * 1960 * 4));
                if (y >= 480) assert.deepEqual(canvas.d.subarray(y * 1960 * 4, (y * 1960 + 1042) * 4), reference.subarray(y * 1960 * 4, (y * 1960 + 1042) * 4));
            }
            fs.writeFileSync(path.join(output, theme + '-' + panel + '.png'), canvas.png(6));
        }
        console.log('14 capturas simuladas; DriveHub y franja inferior sin cambios. Clave enmascarada. ' + output);
    } finally { ui.close(); assistant.close(); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
