'use strict';

const OnlineApp = require('oap-sdk/src/core/OnlineApp.js');
const someipBuilders = require('oap-sdk/src/someip/someipBuilders');
const { observe } = require('./controller.js');
const { report } = require('./telemetria-mgu.js');
const { report: reportNavigation } = require('./navegacion-bmw.js');

const { report: reportRadio } = require('./radio-bmw.js');
const { report: reportAudio } = require('./audio-bmw-transport.js');
const { observeLease } = require('./visibility-lease.js');

function truth(value) { return value === true || value === 1 || value === '1'; }

module.exports = function run() {
    const app = new OnlineApp();
    const telemetry = report(someipBuilders);
    const navigation = reportNavigation(someipBuilders);
    const radio = reportRadio(someipBuilders);
    const audio = reportAudio(someipBuilders);
    let controller;
    let entry;
    let ready = false;
    let visible = false;
    let hmiVisible = false;
    let externallyVisible = false;
    let cockpitVisible = false;
    let closed = false;
    let activeReported, hmiReported;
    let registration = Promise.resolve(), hmiRegistration = Promise.resolve();
    let visibilityGeneration = 0;
    let pending;

    function updatePower() { if (ready && !closed) telemetry.setPower(visible || cockpitVisible); }

    function registerHmiVisibility() {
        hmiRegistration = hmiRegistration.then(async () => {
            if (!ready || closed) return;
            const actual = hmiVisible;
            if (hmiReported !== actual) {
                await (actual ? app.registerHmiVisible() : app.unregisterHmiVisible());
                hmiReported = actual;
            }
        }).catch((err) => console.warn(err.message));
    }
    function registerVisibility() {
        registerHmiVisibility();
        registration = registration.then(async () => {
            if (!ready || closed) return;
            // Serialize transitions so a slow old activation cannot undo a later hide.
            const active = visible;
            if (activeReported !== active) {
                await (active ? app.registerActive() : app.registerInactive());
                activeReported = active;
            }
        }).catch((err) => console.warn(err.message));
        return registration;
    }
    function publish(force) {
        if (closed) return;
        const effective = hmiVisible || externallyVisible;
        const changed = effective !== visible;
        visible = effective;
        if (!ready) return;
        if (changed || force) {
            if (visible && !controller) controller = observe(someipBuilders);
            if (controller) controller.show(visible);
            telemetry.setInteractive(visible);
            navigation.setInteractive(visible);
            updatePower();
            radio.show(visible);
            audio.show(visible);
        }
        registerVisibility();
    }
    function show(value) {
        if (hmiVisible === value) return;
        hmiVisible = value;
        const generation = ++visibilityGeneration;
        // Withdraw real HMI visibility independently of a slow active-register
        // call. Before tearing down the foreground controls and audio, inspect an AA lease that may have
        // been created since the observer's last 250 ms poll.
        registerHmiVisibility();
        if (!value && !externallyVisible) visibilityLease.refresh(() => {
            if (!closed && generation === visibilityGeneration) publish();
        });
        else publish();
    }
    const visibilityLease = observeLease((value) => { externallyVisible = value; publish(); });
    const cockpitLease = observeLease((value) => { cockpitVisible = value; updatePower(); },
        { file: '/run/javi-carlab/cockpit-visible.lease', lifetime: 2500, pollMs: 500 });

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
            if (closed) return;
            const rhmi = app.rhmiApplication;
            if (!rhmi) { await app.initialized(); return; }
            const state = rhmi.getByName('ST_CarLab');
            state.on('visible', (event) => show(truth(event && event.visible)));
            await state.updateResources();
            const tile = app.getEntryPoints().find((item) => app.appDescription.application.entryPoints.some((d) => d.uuid === item.getDescription().uuid));
            if (!tile) throw new Error('CarLab: iDrive no entregó el acceso de la app');
            entry = tile.getDescription().uuid;
            await tile.init();
            await rhmi.mapEntryState(entry, state);
            await tile.setAvailability('ENABLED');
            const start = app.getVisibilityData && app.getVisibilityData();
            const interactiveStart = ['ENTRY_POINT', 'LUM', 'BOOKMARK', 'TRIGGER_HMI']
                .includes((start && start.reason) || app.startReason);
            if (interactiveStart) await app.registerActive();
            await app.initialized();
            if (closed) return;
            ready = true;
            telemetry.show(true);
            navigation.show(true);
            publish(true);
            await open(pending || (interactiveStart && app.getLastExecutedEntryPointUuid && app.getLastExecutedEntryPointUuid()));
        } catch (err) { console.error('CarLab: ' + err.message); }
    });
    app.on('shutdown', () => {
        closed = true;
        visibilityLease.close();
        cockpitLease.close();
        if (controller) controller.close();
        telemetry.show(false);
        navigation.show(false);
        radio.show(false);
        audio.close().then(() => app.destroyBundles()).then(() => process.exit(0), () => process.exit(0));
    });
    app.start().catch((err) => console.error('CarLab: ' + err.message));
};
