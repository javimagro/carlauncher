'use strict';

// Read-only MGU21 declarations. Announced RAMSES content is not proof of visible HUD pixels.
const prefix = 'de.bmw.infotainment.navigation.';
const flags = ['junction3dViewInKombiEnabled', 'visualizationInKombiNonNaviEnabled',
    'additionalInformationEnabled', 'guidingPopupsEnabled', 'signboardPopupsEnabled'];
const services = {
    guidance: { name: prefix + 'guiding.Guidance', attributes: flags },
    hud: { name: 'de.bmw.infotainment.KombiIF', instance: '1', attributes: ['statusHUDSelection'] },
    rendered: { name: prefix + 'guiding.GuidanceRenderedContent', attributes: ['registeredViews'],
        methods: ['getViewConfig', 'getViewContent'], broadcasts: ['viewContentChanged'] }
};
const contentTypes = ['NONE', 'HIGH_GUIDING', 'JUNCTION_VIEW', 'CITY_HIGHWAY_MAP', 'SIGN_POST_INFO', 'SAPA', 'TUNNEL', 'SCREENSHOT', 'NOTIFY'];
const validSequence = (v) => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const good = (v) => v && (v.GenericListError === 0 || v.GenericListError === 'NO_ERROR');
const targetName = (v) => v === 2 || v === 'IC' ? 'IC' : v === 3 || v === 'HUD' ? 'HUD' : null;
const typeName = (v) => typeof v === 'number' && Number.isInteger(v) ? contentTypes[v] || null : contentTypes.includes(v) ? v : null;
const validId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 128 && !/[\x00-\x1f\x7f]/.test(v);

function createDisplays(builders, options) {
    options = options || {};
    const now = options.now || Date.now, every = options.every || setInterval, cancel = options.cancel || clearInterval;
    const records = {}, connections = {}, watchers = [], subscriptions = [], entries = new Map(), jobs = [], pending = new Set();
    let stopped = false, running = 0, registryAt = null, rendered;
    const safe = (fn) => Promise.resolve().then(fn).catch(() => undefined);
    const dispose = (p) => p && typeof p.dispose === 'function' ? safe(() => p.dispose()) : Promise.resolve();
    const fresh = (record) => record && now() >= record.at && now() - record.at <= 15000;
    function drain() {
        while (!stopped && running < 2 && jobs.length) {
            const job = jobs.shift(); running++;
            safe(() => stopped ? undefined : job.run()).then(() => { running--; pending.delete(job.key); drain(); });
        }
    }
    function enqueue(key, run) {
        if (stopped || pending.has(key) || jobs.length >= 40) return;
        pending.add(key); jobs.push({ key, run }); drain();
    }
    function live(entry) { return !stopped && entries.get(entry.id) === entry; }
    function saveContent(entry, value) {
        if (!live(entry)) return;
        // Keep only the small fields needed for observation, never scene IDs or the event payload.
        entry.content = value && typeof value === 'object' ? { at: now(), sequence: value.configSequenceId,
            type: typeName(value.type && value.type.contentType), preview: value.preview } : null;
    }
    function readView(entry) {
        if (!rendered || !live(entry)) return;
        enqueue(entry.configKey, async () => {
            if (!live(entry)) return;
            const result = await rendered.getViewConfig({ viewId: entry.id });
            if (!live(entry) || !good(result)) return;
            const config = result.viewConfig;
            entry.config = { at: now(), target: targetName(config && config.targetUI), sequence: result.configSequenceId };
        });
        enqueue(entry.contentKey, async () => {
            if (!live(entry)) return;
            const revision = entry.notifications;
            const result = await rendered.getViewContent({ viewId: entry.id });
            if (!live(entry) || !good(result) || revision !== entry.notifications) return;
            const content = result.viewContent;
            // A getter can lag an event even when requested afterwards. Do not roll its
            // configuration back while that event is fresh; a new event or expiry resyncs it.
            if (entry.notifications && fresh(entry.content) && content && content.configSequenceId !== entry.content.sequence) return;
            saveContent(entry, content);
        });
    }
    function registry(value) {
        if (!Array.isArray(value)) { registryAt = null; entries.clear(); return; }
        registryAt = now();
        const ids = [];
        // A malformed/unbounded registry cannot multiply work or allocate its entire contents.
        value.slice(0, 128).forEach((id) => { if (ids.length < 16 && validId(id) && !ids.includes(id)) ids.push(id); });
        entries.forEach((entry, id) => { if (!ids.includes(id)) entries.delete(id); });
        ids.forEach((id) => {
            if (!entries.has(id)) entries.set(id, { id, notifications: 0, configKey: {}, contentKey: {} });
        });
        entries.forEach(readView);
    }
    function changed(name, value) {
        if (stopped) return;
        if (name === 'registeredViews') { registry(value); return; }
        if (name === 'statusHUDSelection') {
            const v = value && typeof value === 'object' ? value : {};
            records[name] = { at: now(), value: { statusBacklightHUD3: v.statusBacklightHUD3,
                statusSelectionRadiobuttonHUD: v.statusSelectionRadiobuttonHUD, statusStandscreenHUD: v.statusStandscreenHUD } };
        } else records[name] = { at: now(), value: typeof value === 'boolean' ? value : null };
    }
    async function subscribe(attribute, handler) {
        const id = await attribute.subscribe(handler);
        if (stopped) await safe(() => attribute.unsubscribe(id));
        else subscriptions.push([attribute, id]);
    }
    async function watch(proxy, name) {
        const attribute = proxy[name]; let notifications = 0;
        if (!attribute || typeof attribute.getValue !== 'function' || typeof attribute.subscribe !== 'function') return;
        const reader = () => enqueue(attribute, async () => {
            const revision = notifications;
            const value = await attribute.getValue();
            if (!stopped && revision === notifications) changed(name, value);
        });
        // Subscribe before polling; an event received during a getter wins over that response.
        await safe(() => subscribe(attribute, (value) => { notifications++; changed(name, value); }));
        if (!stopped) { watchers.push(reader); reader(); }
    }
    async function connect(key) {
        const connection = connections[key] || (connections[key] = { pending: false, proxy: null, retryAt: 0 });
        if (stopped || connection.pending || connection.proxy || now() < connection.retryAt) return;
        connection.pending = true;
        const descriptor = services[key]; let proxy;
        try {
            proxy = await builders.buildAndInitTypedProxy(descriptor.name, descriptor.instance || 'Main_Instance', { timeoutMs: 10000 });
            if (stopped) { await dispose(proxy); return; }
            if (key === 'rendered') {
                await subscribe(proxy.viewContentChanged, (event) => {
                    if (stopped || !event || !validId(event.viewId)) return;
                    const entry = entries.get(event.viewId); if (!entry) return;
                    entry.notifications++; saveContent(entry, event.viewContent);
                    if (!entry.config || !entry.content || entry.config.sequence !== entry.content.sequence) readView(entry);
                });
                if (stopped) { await dispose(proxy); return; }
                rendered = proxy;
            }
            connection.proxy = proxy;
            for (const name of descriptor.attributes) { if (stopped) break; await watch(proxy, name); }
        } catch (_) { await dispose(proxy); connection.proxy = null; connection.retryAt = now() + 5000; }
        finally { connection.pending = false; }
    }
    function tick() {
        if (stopped) return;
        Object.keys(services).forEach(connect); watchers.forEach((read) => read());
        if (registryAt !== null && fresh({ at: registryAt })) entries.forEach(readView);
    }
    tick(); const timer = every(tick, 5000);
    return {
        snapshot() {
            const result = { options: {}, hud: { ready: null, layout: null, mapSelected: null }, views: [], available: false };
            const read = (name) => !stopped && fresh(records[name]) ? records[name].value : null;
            flags.forEach((name) => { result.options[name] = read(name); if (result.options[name] !== null) result.available = true; });
            const hud = read('statusHUDSelection');
            if (hud) {
                const ready = hud.statusBacklightHUD3, layout = hud.statusSelectionRadiobuttonHUD, map = hud.statusStandscreenHUD;
                result.hud.ready = [2, 'HUD_ANZEIGEBEREIT'].includes(ready) ? true : [1, 'HUD_NICHT_ANZEIGEBEREIT'].includes(ready) ? false : null;
                const layouts = [[0, 'BEDIENUNG_RADIOBUTTON_BERUHIGTER_MODUS', 'reduced'], [1, 'BEDIENUNG_RADIOBUTTON_ALL_ON', 'all'],
                    [2, 'BEDIENUNG_RADIOBUTTON_INDIVIDUAL', 'individual'], [3, 'BEDIENUNG_RADIOBUTTON_M_ANSICHT', 'm']];
                const found = layouts.find((row) => row[0] === layout || row[1] === layout); result.hud.layout = found ? found[2] : null;
                result.hud.mapSelected = [1, 'NAVIGATIONSKARTE'].includes(map) ? true : [0, 2, 3, 'KEINE_ANZEIGE', 'EFFIZIENZTRAINER', 'TERMINUEBERSICHT'].includes(map) ? false : null;
                if (result.hud.ready !== null || result.hud.layout !== null || result.hud.mapSelected !== null) result.available = true;
            }
            if (!stopped && registryAt !== null && fresh({ at: registryAt })) {
                result.available = true;
                entries.forEach((entry) => {
                    const config = entry.config, content = entry.content;
                    if (!fresh(config) || !config.target) return;
                    const consistent = !!(fresh(content) && validSequence(config.sequence) && config.sequence === content.sequence &&
                        content.type && typeof content.preview === 'boolean');
                    result.views.push({ id: entry.id, target: config.target, type: consistent ? content.type : null,
                        preview: consistent && content.preview, consistent });
                });
            }
            return result;
        },
        stop() {
            if (stopped) return Promise.resolve(); stopped = true; cancel(timer); jobs.length = 0; entries.clear();
            return Promise.all(subscriptions.splice(0).map((s) => safe(() => s[0].unsubscribe(s[1]))).concat(
                Object.keys(connections).map((key) => dispose(connections[key].proxy))));
        }
    };
}
module.exports = { services, createDisplays };
