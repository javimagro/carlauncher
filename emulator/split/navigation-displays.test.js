'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createDisplays, services } = require('../../apps/javi_carlauncher/navegacion-pantallas');
const flush = () => new Promise(setImmediate);
function harness(extra) {
    const callbacks = {}, readers = {}, timers = [], disposed = [], unsubscribed = [], calls = [], attempts = {};
    const values = { statusHUDSelection: { statusBacklightHUD3: 2, statusSelectionRadiobuttonHUD: 1, statusStandscreenHUD: 1 }, registeredViews: ['hud-native', 'ic-native', 'cid-native'] };
    services.guidance.attributes.forEach((name) => { values[name] = true; });
    let clock = 1000, blocked = false;
    const configs = { 'hud-native': { targetUI: 3 }, 'ic-native': { targetUI: 'IC' }, 'cid-native': { targetUI: 1 } };
    const contents = {};
    Object.keys(configs).forEach((id) => { contents[id] = { configSequenceId: 7, type: { contentType: 'HIGH_GUIDING' }, preview: false, ramsesSceneId: 1234, associatedEvent: { private: 'raw' } }; });
    const proxies = {};
    Object.keys(services).forEach((key) => {
        const spec = services[key], p = { dispose() { disposed.push(key); } };
        spec.attributes.forEach((name) => { p[name] = {
            getValue() { calls.push(['get', name]); return readers[name] ? readers[name]() : Promise.resolve(values[name]); },
            async subscribe(fn) { callbacks[name] = fn; return name; }, async unsubscribe(id) { unsubscribed.push(id); }
        }; });
        if (key === 'rendered') {
            p.viewContentChanged = { async subscribe(fn) { callbacks.content = fn; return 'content'; }, async unsubscribe(id) { unsubscribed.push(id); } };
            p.getViewConfig = async ({ viewId }) => { calls.push(['config', viewId]); return { GenericListError: 'NO_ERROR', configSequenceId: 7, viewConfig: configs[viewId] }; };
            p.getViewContent = async ({ viewId }) => { calls.push(['content', viewId]); return { GenericListError: 0, viewContent: contents[viewId] }; };
        }
        proxies[spec.name] = p;
    });
    if (extra) extra({ proxies, values, readers, configs, contents });
    const observer = createDisplays({ async buildAndInitTypedProxy(name, instance) {
        attempts[name] = (attempts[name] || 0) + 1;
        assert.equal(instance, name === services.hud.name ? '1' : 'Main_Instance');
        if (blocked) throw new Error('unavailable');
        return proxies[name];
    } }, { now: () => clock, every(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel(t) { t.cancelled = true; } });
    return { observer, callbacks, values, readers, configs, contents, calls, attempts, proxies, disposed, unsubscribed,
        advance(ms) { clock += ms; }, async tick() { timers.filter((t) => !t.cancelled).forEach((t) => t.fn()); await flush(); },
        setBlocked(v) { blocked = v; } };
}
test('HUD observer reads original display options and distinguishes announced IC/HUD content without raw frames', async () => {
    const r = harness(); await flush();
    try {
        const state = r.observer.snapshot();
        assert.deepEqual(state.hud, { ready: true, layout: 'all', mapSelected: true });
        assert.equal(state.options.signboardPopupsEnabled, true);
        assert.deepEqual(state.views.map((v) => [v.target, v.type, v.preview, v.consistent]), [['HUD', 'HIGH_GUIDING', false, true], ['IC', 'HIGH_GUIDING', false, true]]);
        assert(!JSON.stringify(state).includes('ramsesSceneId')); assert(!JSON.stringify(state).includes('associatedEvent'));
        assert.equal(state.available, true);
        assert(services.rendered.methods.every((m) => m.indexOf('get') === 0));
    } finally { await r.observer.stop(); }
    assert.equal(r.disposed.length, 3); assert.equal(r.unsubscribed.length, 8);
    assert.equal(r.observer.snapshot().available, false);
});
test('display observations expire and invalid HUD enums never become enabled', async () => {
    const r = harness(); await flush();
    try {
        r.callbacks.statusHUDSelection({ statusBacklightHUD3: 3, statusSelectionRadiobuttonHUD: 7, statusStandscreenHUD: 7, statusSelectionDisplayHUD3: 0xffffffff });
        assert.deepEqual(r.observer.snapshot().hud, { ready: null, layout: null, mapSelected: null });
        r.callbacks.statusHUDSelection({ statusBacklightHUD3: 'HUD_NICHT_ANZEIGEBEREIT', statusSelectionRadiobuttonHUD: 'BEDIENUNG_RADIOBUTTON_INDIVIDUAL', statusStandscreenHUD: 'KEINE_ANZEIGE' });
        assert.deepEqual(r.observer.snapshot().hud, { ready: false, layout: 'individual', mapSelected: false });
        r.advance(15001); const stale = r.observer.snapshot();
        assert.equal(stale.available, false); assert.deepEqual(stale.views, []); assert(Object.values(stale.options).every((v) => v === null));
    } finally { await r.observer.stop(); }
});
test('config sequence mismatch and a preview cannot masquerade as live native guidance', async () => {
    const r = harness(); await flush();
    try {
        r.callbacks.content({ viewId: 'hud-native', viewContent: { configSequenceId: 8, type: { contentType: 4 }, preview: false } });
        await flush(); assert.equal(r.observer.snapshot().views[0].consistent, false); assert.equal(r.observer.snapshot().views[0].type, null);
        r.callbacks.content({ viewId: 'hud-native', viewContent: { configSequenceId: 7, type: { contentType: 2 }, preview: true } });
        assert.deepEqual(r.observer.snapshot().views[0], { id: 'hud-native', target: 'HUD', type: 'JUNCTION_VIEW', preview: true, consistent: true });
        r.callbacks.registeredViews(['ic-native']);
        r.callbacks.content({ viewId: 'hud-native', viewContent: r.contents['hud-native'] });
        assert.equal(r.observer.snapshot().views.length, 1);
    } finally { await r.observer.stop(); }
});
test('late field getters cannot overwrite a notification and late view responses cannot resurrect a removed view', async () => {
    const r = harness(); await flush(); let releaseField, releaseContent;
    try {
        r.readers.signboardPopupsEnabled = () => new Promise((resolve) => { releaseField = resolve; });
        r.proxies[services.rendered.name].getViewContent = ({ viewId }) => viewId === 'hud-native' ? new Promise((resolve) => { releaseContent = resolve; }) : Promise.resolve({ GenericListError: 0, viewContent: r.contents[viewId] });
        await r.tick(); assert(releaseField && releaseContent);
        r.callbacks.signboardPopupsEnabled(false); r.callbacks.registeredViews(['ic-native']);
        releaseField(true); releaseContent({ GenericListError: 0, viewContent: r.contents['hud-native'] }); await flush();
        assert.equal(r.observer.snapshot().options.signboardPopupsEnabled, false);
        assert.deepEqual(r.observer.snapshot().views.map((v) => v.id), ['ic-native']);
    } finally { await r.observer.stop(); }
});
test('view registry work stays bounded to sixteen views and two concurrent method reads', async () => {
    let running = 0, maxRunning = 0; const release = [];
    const r = harness(({ proxies, values, configs, contents }) => {
        values.registeredViews = Array.from({ length: 100 }, (_, i) => 'view-' + i).concat(['x'.repeat(129)]);
        values.registeredViews.forEach((id) => { configs[id] = { targetUI: 3 }; contents[id] = { configSequenceId: 1, type: { contentType: 4 }, preview: false }; });
        proxies[services.rendered.name].getViewConfig = ({ viewId }) => new Promise((resolve) => {
            running++; maxRunning = Math.max(maxRunning, running);
            release.push(() => { running--; resolve({ GenericListError: 0, configSequenceId: 1, viewConfig: configs[viewId] }); });
        });
    }); await flush();
    try {
        for (let i = 0; i < 30; i++) { release.splice(0).forEach((resolve) => resolve()); await flush(); }
        assert(maxRunning <= 2); assert.equal(r.observer.snapshot().views.length, 16);
        assert(r.calls.filter((c) => c[0] === 'content').every((c) => Number(c[1].slice(5)) < 16));
    } finally { await r.observer.stop(); release.splice(0).forEach((resolve) => resolve()); }
});
test('unavailable services retry at five seconds and shutdown disposes a late-created proxy', async () => {
    let time = 1000, calls = 0, disposed = 0; const timers = [], builds = [];
    const observer = createDisplays({ buildAndInitTypedProxy() {
        calls++; if (calls <= 3) return Promise.reject(new Error('absent'));
        return new Promise((resolve) => { builds.push(resolve); });
    } }, { now: () => time, every(fn) { timers.push(fn); return fn; }, cancel() {} });
    await flush(); timers[0](); await flush(); assert.equal(calls, 3);
    time += 5000; timers[0](); await flush(); assert.equal(calls, 6); assert.equal(builds.length, 3);
    await observer.stop(); builds.forEach((resolve) => resolve({ dispose() { disposed++; } })); await flush();
    assert.equal(disposed, 3); assert.equal(observer.snapshot().available, false);
});

test('an old response cannot overwrite a re-registered view with the same ID', async () => {
    const r = harness(); await flush(); let oldReply;
    try {
        const proxy = r.proxies[services.rendered.name];
        const original = proxy.getViewContent;
        proxy.getViewContent = ({ viewId }) => viewId === 'hud-native' ? new Promise((resolve) => { oldReply = resolve; }) : original({ viewId });
        await r.tick(); assert(oldReply);
        proxy.getViewContent = original;
        r.callbacks.registeredViews(['ic-native']);
        r.contents['hud-native'] = { configSequenceId: 7, type: { contentType: 'SIGN_POST_INFO' }, preview: false };
        r.callbacks.registeredViews(['hud-native', 'ic-native']); await flush();
        oldReply({ GenericListError: 0, viewContent: { configSequenceId: 7, type: { contentType: 'NONE' }, preview: false } }); await flush();
        assert.equal(r.observer.snapshot().views.find((v) => v.id === 'hud-native').type, 'SIGN_POST_INFO');
        await r.observer.stop(); r.callbacks.content({ viewId: 'hud-native', viewContent: r.contents['hud-native'] });
        assert.equal(r.observer.snapshot().available, false);
    } finally { await r.observer.stop(); }
});
