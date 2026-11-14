'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createActions, contracts } = require('../../apps/javi_carlauncher/navegacion-acciones');
const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
const displays = require('../../native/javi-carlab/navigation-displays');
const { controls } = require('../../native/javi-carlab/navigation-panels');
const { Recorder } = require('./software-renderer');
const flush = () => new Promise(setImmediate);

test('native guidance preferences require one explicit allowed action and BMW readback, never start or stop a route', async () => {
    const calls = [], values = {}; let reject = false;
    const p = { dispose() {}, startGuidance() { calls.push('start'); }, stopGuidance() { calls.push('stop'); } };
    for (const key of Object.keys(contracts.guidance.attributes)) p[key] = {
        async getValue() { calls.push(['read', key]); return values[key] === true; },
        async setValue(value) { calls.push(['write', key, value]); if (!reject) values[key] = value; }
    };
    const engine = createActions({ async buildAndInitTypedProxy(name) { assert.equal(name, contracts.guidance.name); return p; } });
    const command = { action: 'guidance-setting', request: 1, setting: 'junction3dViewInKombiEnabled', enabled: true };
    assert.equal(calls.length, 0);
    await engine.command({ ...command, setting: 'standardColorSetOn' }); assert.equal(calls.length, 0);
    await engine.command({ ...command, enabled: 1 }); assert.equal(calls.length, 0);
    await engine.command(command); assert.equal(engine.snapshot().error, ''); assert.equal(engine.snapshot().status, 'idle');
    await engine.command(command); assert.equal(calls.filter((c) => c[0] === 'write').length, 1);
    reject = true; await engine.command({ ...command, request: 2, enabled: false });
    assert.equal(engine.snapshot().error, 'BMW_GUIDANCE_SETTING_REJECTED');
    await engine.stop(); assert(!calls.includes('start')); assert(!calls.includes('stop'));
});

test('closing while a preference proxy connects cannot write a late setting', async () => {
    let resolve, writes = 0;
    const pending = new Promise((r) => { resolve = r; });
    const engine = createActions({ buildAndInitTypedProxy() { return pending; } });
    const action = engine.command({ action: 'guidance-setting', request: 1, setting: 'guidingPopupsEnabled', enabled: true });
    await flush(); engine.stop();
    resolve({ dispose() {}, guidingPopupsEnabled: { setValue() { writes++; }, getValue() { return true; } } });
    await action; assert.equal(writes, 0);
});

test('HUD display panel uses only fresh known preferences and a setting reply keeps the panel open', () => {
    const commands = [], ui = createNavigationUI({ navigationCommand(c) { commands.push(c); return true; } }, () => {});
    const options = {}; displays.settings.forEach((s) => { options[s[0]] = false; });
    const nav = { state: 'inactive', points: [], theme: 'night', presentation: { options, available: true,
        hud: { ready: true, layout: null, mapSelected: null }, views: [{ id: 'any-name', target: 'HUD', type: 'HIGH_GUIDING', consistent: true, preview: false }] } };
    try {
        ui.update(nav, {}, true); ui.activate('settings'); controls(new Recorder(1960, 520), ui, nav);
        const row = ui.state.buttons.find((b) => b.id === 'guidance-displays');
        ui.touch('down', row.x + 10, row.y + 10); ui.touch('up', row.x + 10, row.y + 10); assert.equal(ui.state.panel, 'guidance-displays');
        ui.activate('guidance-setting:guidingPopupsEnabled'); assert.equal(commands.length, 1); assert.equal(commands[0].enabled, true);
        const c = { request: commands[0].request, busy: false, status: 'idle', error: '' };
        ui.update({ ...nav, controls: c }, {}, true); assert.equal(ui.state.panel, 'guidance-displays');
        ui.update({ state: 'unavailable', theme: 'auto', points: [] }, {}, true);
        ui.activate('guidance-setting:guidingPopupsEnabled'); assert.equal(commands.length, 1);
        assert.equal(displays.summary(nav.presentation, 'HUD'), 'Maniobra');
        assert.equal(displays.summary({ ...nav.presentation, views: [{ ...nav.presentation.views[0], consistent: false }] }, 'HUD'), 'Sin contenido anunciado');
        assert.equal(displays.validate(nav.presentation), true);
        assert.equal(displays.validate({ ...nav.presentation, views: [{ ...nav.presentation.views[0], target: 'MAIN' }] }), false);
    } finally { ui.close(); }
});
