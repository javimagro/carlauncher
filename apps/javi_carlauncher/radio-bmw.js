'use strict';

const net = require('net');
const { StringDecoder } = require('string_decoder');
const { services, lists, station, sources, picture, pictureDetails, clean, seconds } = require('./radio-datos.js');
const { createLists } = require('./radio-listas.js');
const safe = (fn) => Promise.resolve().then(fn).catch(() => undefined);

function createRadio(builders, options) {
    options = options || {};
    const now = options.now || Date.now, every = options.every || setInterval, cancel = options.cancel || clearInterval;
    const proxies = {}, subscriptions = [], pendingSubscriptions = new Set(), timers = [], records = {};
    const closedProxies = new WeakSet();
    let closing;
    const stationLists = createLists(now);
    let stopped = false, loading = false, wanted = true, lastLoad = -Infinity, busy = false, result = null;
    let current = null, currentAt = 0, logo = null, logoKey = '', logoSerial = 0;
    let listError = '', incomplete = false;
    let artwork = null, artworkBusy = false, artworkSerial = 0;
    function closeProxy(proxy) {
        if (closedProxies.has(proxy)) return Promise.resolve();
        closedProxies.add(proxy);
        const shutdown = proxy.shutdown || proxy.dispose;
        return safe(() => typeof shutdown === 'function' && shutdown.call(proxy));
    }
    function changed(name, value) {
        if (stopped) return;
        records[name] = { value, at: now() };
        if (name === 'currentStationFmDab') {
            current = station(value && value.stationListEntry, 2); currentAt = now();
            const next = picture(value && value.stationListEntry && value.stationListEntry.stationIconPicture);
            if (next !== logo || (current && current.key) !== logoKey) { logo = next; logoKey = current && current.key || ''; logoSerial++; }
            if (current) current.text = clean(value.radioTextName, 180);
        }
    }
    function subscribe(attr, fn) {
        if (!attr || typeof attr.subscribe !== 'function') return;
        const pending = safe(async () => {
            const id = await attr.subscribe(fn);
            if (stopped) return safe(() => attr.unsubscribe(id));
            subscriptions.push([attr, id]);
        });
        pendingSubscriptions.add(pending);
        pending.then(() => pendingSubscriptions.delete(pending));
        return pending;
    }
    function watch(proxy, name) {
        const attr = proxy[name]; if (!attr) return;
        let pending = false, serial = 0;
        subscribe(attr, (value) => { serial++; changed(name, value); });
        async function read() {
            if (pending || stopped) return;
            pending = true; const seen = serial;
            try { const value = await attr.getValue(); if (seen === serial) changed(name, value); }
            catch (_) { /* Values expire independently; never turn a failed read into an empty station. */ }
            finally { pending = false; }
        }
        read(); timers.push(every(read, 5000));
    }
    async function refresh() {
        if (stopped || loading || busy || !proxies.tuner || (!wanted && now() - lastLoad < 30000) || now() - lastLoad < 2000) return;
        loading = true; wanted = false; lastLoad = now();
        const errors = []; incomplete = false;
        try {
            for (const list of lists) {
                if (stopped) return;
                const revision = stationLists.revision(list);
                // Subscribe first, then request the actual list. Metadata alone is not a list subscription.
                await safe(() => !stopped && proxies.tuner.triggerStationListBroadcast({ listType: list }));
                try {
                    let found = [], full = false;
                    // BMW's metadata list is one-based; its Hmi8 cache rejects row zero.
                    for (let start = 1; start <= 500 && !stopped; start += 32) {
                        const args = { listType: list, pictures: 0, epgDataScope: 1, startPosition: start, length: Math.min(32, 501 - start) };
                        let response;
                        try { response = await proxies.tuner.getStationListMetaData(args); }
                        catch (error) { if (stopped || !proxies.metadata) throw error; response = await proxies.metadata.getStationListMetaData(args); }
                        if (stopped) return;
                        const rows = response && response.stationList;
                        if (!Array.isArray(rows) || rows.length > args.length) throw new Error('LIST_FORMAT');
                        found = found.concat(rows);
                        if (rows.length < args.length) { full = true; break; }
                        if (revision !== stationLists.revision(list)) break;
                    }
                    if (stopped) return;
                    // Do not let an empty metadata cache erase a current broadcast list.
                    if (found.length || !stationLists.all().some((s) => s.list === list)) stationLists.commit(list, found, revision, true);
                    incomplete = incomplete || (!full && found.length >= 500);
                } catch (_) { if (!stopped) errors.push(list); }
            }
            listError = errors.length && !stationLists.all().length ? 'BMW no ha entregado las listas; reintentando' : '';
        }
        finally { loading = false; }
    }
    const connecting = {};
    function connect(key) {
        if (stopped || proxies[key] || connecting[key]) return;
        const pending = connectProxy(key);
        connecting[key] = pending;
        pending.then(() => { delete connecting[key]; });
        return pending;
    }
    async function connectProxy(key) {
        const d = services[key];
        try {
            const proxy = await builders.buildAndInitTypedProxy(d.name, '1', { timeoutMs: 8000 });
            if (stopped) { await closeProxy(proxy); return; }
            proxies[key] = proxy;
            d.attributes.forEach((name) => watch(proxy, name));
            if (key === 'tuner') {
                await subscribe(proxy.dataStationList, (event) => {
                    if (!stopped && !stationLists.receive(event)) wanted = true;
                });
                if (stopped) return;
                refresh(); timers.push(every(refresh, 2000));
            }
        } catch (_) { if (!stopped && key === 'tuner') listError = 'Radio BMW no disponible'; }
    }
    const ready = Promise.all(Object.keys(services).map(connect));
    timers.push(every(() => Object.keys(services).forEach(connect), 10000));
    function fresh(name) { const r = records[name]; return r && now() - r.at < 15000 ? r.value : undefined; }
    const listed = stationLists.all;
    function radioSource() {
        const available = sources(fresh('sources'));
        const activeId = fresh('activeSourceId');
        return available.find((v) => v.id === activeId && v.selectable && v.type !== 2) ||
            available.find((v) => v.type === 4 && v.selectable) || available.find((v) => v.type === 1 && v.selectable);
    }
    function resolveStation(key, list, memoryKey) {
        const row = stationLists.find(key, list);
        if (!memoryKey || row && row.memoryKey === memoryKey) return row;
        return listed().find((s) => s.memoryKey === memoryKey && stationLists.find(s.key, s.list));
    }
    async function command(c) {
        if (stopped || !c || typeof c.id !== 'string' || c.id.length > 40 ||
            !['activate', 'tune', 'refresh', 'artwork'].includes(c.op) ||
            (c.memoryKey !== undefined && (typeof c.memoryKey !== 'string' || !c.memoryKey.length || c.memoryKey.length > 110))) return false;
        if ((c.op === 'tune' || c.op === 'artwork') &&
            (typeof c.key !== 'string' || !/^\d{1,10}$/.test(c.key) || !lists.includes(c.list))) return false;
        if (c.op === 'artwork') {
            if (artworkBusy || busy || !proxies.tuner) return false;
            const item = resolveStation(c.key, c.list, c.memoryKey);
            if (!item) return false;
            artworkBusy = true;
            try {
                let bytes = null; const attempts = [];
                for (const source of ['metadata', 'tuner']) {
                    const proxy = proxies[source]; if (!proxy) continue;
                    const live = resolveStation(item.key, item.list, item.memoryKey);
                    if (stopped || !live) return false;
                    const r = await safe(() => proxy.getStationListMetaData({ listType: live.list, pictures: 1, epgDataScope: 0, startPosition: live.position, length: 1 }));
                    if (stopped) return false;
                    const row = r && Array.isArray(r.stationList) && r.stationList.find((v) => {
                        const candidate = station(v, live.list);
                        return candidate && candidate.id === live.id && candidate.memoryKey === item.memoryKey;
                    });
                    const info = row ? pictureDetails(row.stationIconPicture) : { bytes: null, status: r && Array.isArray(r.stationList) ? 'missing-row' : 'query-failed', size: 0, format: null };
                    attempts.push({ source, status: info.status, size: info.size, format: info.format });
                    bytes = info.bytes;
                    if (bytes) break;
                }
                // Two bounded diagnostic entries, no URL, raw SDK error or extra image copies.
                artwork = { key: c.key, serial: ++artworkSerial, bytes, attempts };
                return true;
            } catch (_) { if (!stopped) artwork = { key: c.key, serial: ++artworkSerial, bytes: null }; return false; }
            finally { artworkBusy = false; }
        }
        if (busy) return false;
        if (c.op === 'refresh') { wanted = true; refresh(); return true; }
        const tuning = c.op === 'tune';
        const s = tuning && resolveStation(c.key, c.list, c.memoryKey);
        if (tuning && (!s || !proxies.tuner)) {
            wanted = true; result = { id: c.id, ok: false, message: 'La lista ha cambiado; vuelve a seleccionar la emisora' }; return false;
        }
        const source = proxies.media && radioSource();
        if (!source) { result = { id: c.id, ok: false, message: 'BMW no ofrece una fuente FM/DAB disponible' }; return false; }
        busy = true; result = { id: c.id, ok: null, message: tuning ? 'Sintonizando…' : 'Activando radio…' };
        let stage = 'fuente', nativeCode;
        try {
            // Hmi8 requests audio on every explicit station selection. An active
            // source ID alone does not establish an audible connection after an interruption.
            const selected = await proxies.media.selectSource({ sourceId: source.id });
            nativeCode = selected && selected.result;
            if (![0, 2, 'NO_ERROR', 'SOURCE_ALREADY_SELECTED'].includes(nativeCode)) throw new Error('SOURCE');
            if (stopped) return false;
            if (!tuning) {
                result = { id: c.id, ok: true, message: 'Fuente de radio solicitada a BMW' };
                return true;
            }
            // Resolve the index again after source activation; never tune a different row after a list update.
            const live = resolveStation(s.key, s.list, c.memoryKey);
            if (!live) throw new Error('STATION');
            stage = 'emisora'; nativeCode = undefined;
            const tuned = await proxies.tuner.selectStation({ listType: live.list, dataBaseIdentifier: live.id, positionIndex: live.position });
            nativeCode = tuned && tuned.errorCode;
            if (![0, 'EC_NO_ERROR'].includes(nativeCode)) throw new Error('TUNE');
            if (!stopped) result = { id: c.id, ok: true, message: 'Emisora solicitada a BMW' };
            return !stopped;
        } catch (error) {
            // Only expose the bounded enum/code, never arbitrary SDK error text or source IDs.
            const code = Number.isInteger(nativeCode) || typeof nativeCode === 'string' && /^[A-Z0-9_]{1,48}$/.test(nativeCode)
                ? String(nativeCode) : 'sin confirmación';
            if (!stopped) result = { id: c.id, ok: false, message: error && error.message === 'STATION'
                ? 'La lista ha cambiado; vuelve a seleccionar la emisora' : 'BMW no ha activado la ' + stage + ' (' + code + ')' };
            return false;
        }
        finally { busy = false; }
    }
    return { ready, command, refresh,
        snapshot() {
            const available = sources(fresh('sources')), activeId = fresh('activeSourceId');
            const live = current && now() - currentAt < 15000 ? current : null;
            const clock = seconds(fresh('epgReferenceTime'));
            return { version: 1, at: now(), available: !!proxies.tuner, loading, busy, listError, incomplete,
                clock: clock === null ? null : (clock + Math.floor((now() - records.epgReferenceTime.at) / 1000)) % 86400,
                stations: listed(), current: live, active: typeof activeId === 'string' && available.some((s) => s.id === activeId),
                sourceKnown: typeof activeId === 'string', canActivate: !!(proxies.media && radioSource()), result, artworkBusy, artwork,
                logo: live && logo ? { key: logoKey, serial: logoSerial, bytes: logo } : null };
        },
        stop() {
            if (closing) return closing;
            stopped = true; timers.forEach(cancel);
            closing = Promise.all(Object.keys(connecting).map((key) => connecting[key]))
                .then(() => Promise.all(Array.from(pendingSubscriptions)))
                .then(() => Promise.all(subscriptions.splice(0).map(([attr, id]) => safe(() => attr.unsubscribe(id)))))
                .then(() => Promise.all(Object.keys(proxies).map((key) => closeProxy(proxies[key]))));
            // Do not stop/mute the original radio when our card or app is hidden.
            return closing;
        }
    };
}

function report(builders, endpoint = '/run/javi-carlab/radio.sock') {
    let radio, socket, timer;
    function send() {
        if (!radio) return;
        if (!socket) {
            const peer = net.createConnection(endpoint); socket = peer;
            const decoder = new StringDecoder('utf8'); let partial = '';
            peer.on('data', (chunk) => {
                if (peer !== socket || !radio) return;
                if (chunk.length > 4096) { peer.destroy(); return; }
                const lines = (partial + decoder.write(chunk)).split('\n'); partial = lines.pop();
                if (Buffer.byteLength(partial) > 4096 || lines.length > 8) { peer.destroy(); return; }
                for (const line of lines) {
                    if (Buffer.byteLength(line) > 4096) { peer.destroy(); return; }
                    try { radio.command(JSON.parse(line)).catch(() => {}); } catch (_) { peer.destroy(); return; }
                }
            });
            peer.on('error', () => {});
            peer.on('connect', () => { if (socket === peer) send(); });
            peer.on('close', () => { if (socket === peer) socket = null; });
        } else if (!socket.connecting && !socket.destroyed && !socket.bufferSize) {
            const frame = radio.snapshot(); let message = JSON.stringify(frame);
            // The maximum legal SOME/IP list can contain long UTF-8 names. Keep transport bounded too.
            while (Buffer.byteLength(message) > 1024 * 1024 && frame.stations.length) {
                frame.stations.splice(-32); frame.incomplete = true; message = JSON.stringify(frame);
            }
            if (Buffer.byteLength(message) <= 1024 * 1024) socket.write(message + '\n', 'utf8');
        }
    }
    return { show(on) {
        if (on && !radio) { radio = createRadio(builders); timer = setInterval(send, 1000); send(); }
        else if (!on && radio) { clearInterval(timer); radio.stop(); radio = null; if (socket) socket.destroy(); socket = null; }
    } };
}
module.exports = { createRadio, report };
