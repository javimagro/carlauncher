'use strict';

const net = require('net');
const { StringDecoder } = require('string_decoder');
const { services, lists, station, sources, picture, clean, seconds } = require('./radio-datos.js');
const safe = (fn) => Promise.resolve().then(fn).catch(() => undefined);

function createRadio(builders, options) {
    options = options || {};
    const now = options.now || Date.now, every = options.every || setInterval, cancel = options.cancel || clearInterval;
    const proxies = {}, subscriptions = [], timers = [], records = {}, pages = {};
    let stopped = false, loading = false, wanted = true, lastLoad = -Infinity, busy = false, result = null;
    let listRevision = 0, current = null, currentAt = 0, logo = null, logoKey = '', logoSerial = 0;
    let listError = '', incomplete = false;
    let artwork = null, artworkBusy = false, artworkSerial = 0;
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
        safe(async () => {
            const id = await attr.subscribe(fn);
            if (stopped) return safe(() => attr.unsubscribe(id));
            subscriptions.push([attr, id]);
        });
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
        loading = true; wanted = false; lastLoad = now(); const revision = listRevision;
        try {
            for (const list of lists) {
                const found = new Map(); let full = false;
                for (let start = 0; start < 500 && !stopped; start += 32) {
                    const response = await proxies.tuner.getStationListMetaData({ listType: list, pictures: 0, epgDataScope: 1,
                        startPosition: start, length: Math.min(32, 500 - start) });
                    if (stopped) return;
                    const rows = response && response.stationList;
                    if (!Array.isArray(rows) || rows.length > 32) throw new Error('LIST_FORMAT');
                    rows.forEach((v) => { const s = station(v, list, true); if (s) found.set(s.key, s); });
                    if (rows.length < 32) { full = true; break; }
                }
                if (stopped) return;
                // A list event can move indices while pages are being read. Retry the whole snapshot.
                if (revision !== listRevision) { wanted = true; return; }
                pages[list] = { rows: Array.from(found.values()), at: now(), revision };
                incomplete = !full && found.size >= 500;
            }
            listError = '';
        } catch (_) { if (!stopped) listError = 'No se pudo actualizar la lista BMW'; }
        finally { loading = false; }
    }
    const connecting = {};
    async function connect(key) {
        if (stopped || proxies[key] || connecting[key]) return;
        connecting[key] = true;
        const d = services[key];
        try {
            const proxy = await builders.buildAndInitTypedProxy(d.name, '1', { timeoutMs: 8000 });
            if (stopped) { safe(() => proxy.dispose()); return; }
            proxies[key] = proxy;
            d.attributes.forEach((name) => watch(proxy, name));
            if (key === 'tuner') {
                subscribe(proxy.dataStationList, () => { if (!stopped) { listRevision++; wanted = true; } });
                refresh(); timers.push(every(refresh, 2000));
            }
        } catch (_) { if (!stopped) listError = 'Radio BMW no disponible'; }
        finally { connecting[key] = false; }
    }
    const ready = Promise.all(Object.keys(services).map(connect));
    timers.push(every(() => Object.keys(services).forEach(connect), 10000));
    function fresh(name) { const r = records[name]; return r && now() - r.at < 15000 ? r.value : undefined; }
    function listed() {
        return lists.reduce((all, list) => all.concat(pages[list] && now() - pages[list].at < 90000 ? pages[list].rows : []), []);
    }
    async function command(c) {
        if (stopped || !c || typeof c.id !== 'string' || c.id.length > 40 || !['tune', 'refresh', 'artwork'].includes(c.op)) return false;
        if (c.op === 'artwork') {
            if (artworkBusy || busy || !proxies.tuner) return false;
            const item = listed().find((v) => v.key === c.key && v.list === c.list);
            if (!item) return false;
            artworkBusy = true;
            try {
                const r = await proxies.tuner.getStationListMetaData({ listType: item.list, pictures: 1, epgDataScope: 0, startPosition: item.position, length: 1 });
                if (stopped) return false;
                const row = r && Array.isArray(r.stationList) && r.stationList.find((v) => v.dataBaseIdentifier === item.id);
                artwork = { key: item.key, serial: ++artworkSerial, bytes: picture(row && row.stationIconPicture) };
                return true;
            } catch (_) { if (!stopped) artwork = { key: item.key, serial: ++artworkSerial, bytes: null }; return false; }
            finally { artworkBusy = false; }
        }
        if (busy) return false;
        if (c.op === 'refresh') { wanted = true; refresh(); return true; }
        const s = listed().find((v) => v.key === c.key && v.list === c.list);
        if (!s || pages[s.list].revision !== listRevision || !proxies.tuner || !proxies.media) {
            wanted = true; result = { id: c.id, ok: false, message: 'La lista ha cambiado; vuelve a seleccionar la emisora' }; return false;
        }
        const available = sources(fresh('sources'));
        const activeId = fresh('activeSourceId');
        const source = available.find((v) => v.id === activeId && v.selectable && v.type !== 2) ||
            available.find((v) => v.type === 4 && v.selectable) || available.find((v) => v.type === 1 && v.selectable);
        if (!source) { result = { id: c.id, ok: false, message: 'BMW no ofrece una fuente FM/DAB disponible' }; return false; }
        busy = true; result = { id: c.id, ok: null, message: 'Sintonizando…' };
        try {
            if (source.id !== activeId) {
                const selected = await proxies.media.selectSource({ sourceId: source.id });
                if (!selected || ![0, 2, 'NO_ERROR', 'SOURCE_ALREADY_SELECTED'].includes(selected.result)) throw new Error('SOURCE');
            }
            if (stopped) return false;
            // Resolve the index again after source activation; never tune a different row after a list update.
            const live = listed().find((v) => v.key === s.key && v.list === s.list);
            if (!live || pages[live.list].revision !== listRevision) throw new Error('STATION');
            const tuned = await proxies.tuner.selectStation({ listType: live.list, dataBaseIdentifier: live.id, positionIndex: live.position });
            if (!tuned || ![0, 'EC_NO_ERROR'].includes(tuned.errorCode)) throw new Error('TUNE');
            if (!stopped) result = { id: c.id, ok: true, message: 'Emisora solicitada a BMW' };
            return !stopped;
        } catch (_) { if (!stopped) result = { id: c.id, ok: false, message: 'BMW no ha aceptado la sintonización' }; return false; }
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
                sourceKnown: typeof activeId === 'string', result, artworkBusy, artwork,
                logo: live && logo ? { key: logoKey, serial: logoSerial, bytes: logo } : null };
        },
        stop() {
            if (stopped) return; stopped = true; timers.forEach(cancel);
            subscriptions.forEach(([attr, id]) => safe(() => attr.unsubscribe(id)));
            Object.keys(proxies).forEach((key) => safe(() => proxies[key].dispose()));
            // Do not stop/mute the original radio when our card or app is hidden.
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
