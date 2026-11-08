'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');

function truth(value) { return value === true || value === 1 || value === '1'; }

module.exports = function run(screen) {
    const app = new OnlineApp();
    let entry;
    let ready = false;
    let visible = false;
    let pending;

    function show(value) {
        if (visible === value) return;
        visible = value;
        if (screen) screen.show(visible);
        if (!ready) return;
        const reports = visible ? [app.registerActive(), app.registerHmiVisible()] : [app.unregisterHmiVisible(), app.registerInactive()];
        Promise.all(reports).catch((err) => console.warn(err.message));
    }

    function open(uuid) {
        if (!ready) { pending = uuid; return; }
        if (!uuid || uuid !== entry) return;
        return Promise.resolve(app.rhmiApplication.openEntryState(uuid));
    }

    app.on('entryPointExecute', (uuid) => Promise.resolve(open(uuid)).catch((err) => console.warn(err.message)));
    app.on('changeVisibility', (ev) => { if (ev && ev.visible === false) show(false); });
    app.on('error', (err) => console.warn(err.message));
    app.on('initialized', async () => {
        try {
            const rhmi = app.rhmiApplication;
            if (!rhmi) { await app.initialized(); return; }
            const state = rhmi.getByName('ST_CarLab');
            state.on('visible', (event) => show(truth(event && event.visible)));
            if (screen) screen.bind(rhmi, truth);
            await state.updateResources();
            const tile = app.getEntryPoints().find((item) => app.appDescription.application.entryPoints.some((d) => d.uuid === item.getDescription().uuid));
            if (!tile) throw new Error('CarLab: iDrive no entregó el acceso de la app');
            entry = tile.getDescription().uuid;
            await tile.init();
            await rhmi.mapEntryState(entry, state);
            await tile.setAvailability('ENABLED');
            const start = app.getVisibilityData && app.getVisibilityData();
            if (['ENTRY_POINT', 'LUM', 'BOOKMARK', 'TRIGGER_HMI'].indexOf((start && start.reason) || app.startReason) >= 0) {
                await app.registerActive();
            }
            await app.initialized();
            ready = true;
            if (visible) await app.registerHmiVisible();
            await open(pending || (app.getLastExecutedEntryPointUuid && app.getLastExecutedEntryPointUuid()));
        } catch (err) { console.error('CarLab: ' + err.message); }
    });
    app.on('shutdown', () => {
        if (screen) screen.close();
        Promise.resolve(app.destroyBundles()).then(() => process.exit(0), () => process.exit(0));
    });
    app.start().catch((err) => console.error('CarLab: ' + err.message));
};
