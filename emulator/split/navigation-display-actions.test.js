'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createActions, contracts } = require('../../apps/javi_carlauncher/navegacion-acciones');
const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
const displays = require('../../native/javi-carlab/navigation-displays');
const { controls } = require('../../native/javi-carlab/navigation-panels');
const { Recorder } = require('./software-renderer');
const { createDisplays, services } = require('../../apps/javi_carlauncher/navegacion-pantallas');
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

test('map speaker toggles only BMW voice, reflects confirmed state and keeps a route open on rejection', async (t) => {
    const notices = [], writes = [];
    let voice = true, reject = false, operation;
    const builders = { async buildAndInitTypedProxy(name) {
        assert.equal(name, services.guidance.name);
        return { voiceGuidanceEnabled: {
            async setValue(value) { writes.push(value); if (!reject) voice = value; },
            async getValue() { return voice; }, async subscribe() { return 1; }, async unsubscribe() {}
        } };
    } };
    const observer = createDisplays(builders);
    const engine = createActions(builders, { onGuidanceSetting: observer.confirmSetting });
    const ui = createNavigationUI({ notify: (msg) => notices.push(msg), navigationCommand(command) {
        assert.equal(command.setting, 'voiceGuidanceEnabled'); operation = engine.command(command); return true;
    } }, () => {});
    t.after(async () => { ui.close(); await engine.stop(); await observer.stop(); });
    const nav = { state: 'active', points: [], destinations: [], theme: 'night' };
    function update() { ui.update({ ...nav, presentation: observer.snapshot(), controls: engine.snapshot() }, {}, true); }
    function speaker() {
        const cv = new Recorder(1960, 520);
        controls(cv, ui, { ...nav, presentation: observer.snapshot() });
        return ui.state.buttons.find((b) => b.id === 'audio');
    }
    update(); assert(speaker().disabled);
    await flush(); update(); assert(!speaker().disabled);
    ui.state.panel = 'route';
    for (const enabled of [false, true]) {
        const b = speaker();
        ui.touch('down', b.x + 20, b.y + 20); ui.touch('up', b.x + 20, b.y + 20);
        assert(speaker().disabled);
        await operation; update();
        assert.equal(observer.snapshot().options.voiceGuidanceEnabled, enabled);
        assert.equal(ui.state.panel, 'route');
    }
    reject = true; ui.activate('audio'); await operation; update();
    assert.equal(observer.snapshot().options.voiceGuidanceEnabled, true);
    assert.equal(ui.state.panel, 'route');
    assert.deepEqual(writes, [false, true, false]);
    assert.match(notices[0], /silenciadas/); assert.match(notices[1], /activadas/); assert.match(notices[2], /no ha confirmado/);
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
        controls(new Recorder(1960, 520), ui, nav);
        const known = ui.state.buttons.filter((b) => b.id.startsWith('guidance-setting:'));
        assert.equal(known.length, 5); assert(known.every((b) => !b.disabled));
        ui.activate('guidance-setting:guidingPopupsEnabled'); assert.equal(commands.length, 1); assert.equal(commands[0].enabled, true);
        const c = { request: commands[0].request, busy: false, status: 'idle', error: '' };
        ui.update({ ...nav, controls: c }, {}, true); assert.equal(ui.state.panel, 'guidance-displays');
        const unavailable = { state: 'unavailable', theme: 'auto', points: [] };
        ui.update(unavailable, {}, true);
        controls(new Recorder(1960, 520), ui, unavailable);
        const stale = ui.state.buttons.filter((b) => b.id.startsWith('guidance-setting:'));
        assert.equal(stale.length, 5); assert(stale.every((b) => b.disabled));
        ui.activate('guidance-setting:guidingPopupsEnabled'); assert.equal(commands.length, 1);
        assert.equal(displays.validate(nav.presentation), true);
        assert.equal(displays.validate({ ...nav.presentation, views: [{ ...nav.presentation.views[0], target: 'MAIN' }] }), false);
    } finally { ui.close(); }
});
