'use strict';

// MGU21 contract: MediaPlayer 0xb042/2, OapGenericMedia=40; CommandControl 0xb020/1.
const mediaName = 'de.bmw.infotainment.entertainment.mediaplayer.MediaPlayer';
const controlName = 'org.genivi.am.commandinterface.CommandControl';
const sourceID = 1046, sinkID = 1024;
const ok = (v) => v === 0 || v === 'E_OK';
const plays = (v) => v === 1 || v === 'PLAYER_STATE_PLAY';
const idle = (v) => v === 0 || v === 2 || v === 'PLAYER_STATE_UNKNOWN' || v === 'PLAYER_STATE_STOP';
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{16}$/.test(id);
const samplePath = (id) => '/dev/shm/bmw-tdt-native-' + id + '/audio.wav';
const safe = (fn) => Promise.resolve().then(fn).catch(() => undefined);

function createAudio(builders, emit, options) {
    options = options || {};
    const now = options.now || Date.now;
    let job = null, closed = false;
    function send(j, state, extra) {
        if (!closed && job === j && !j.cancelled) emit(Object.assign({ id: j.id, state }, extra));
    }
    function active(j) { return !closed && job === j && !j.cancelled; }
    function check(j) { if (!active(j)) throw new Error('cancelled'); }
    async function connections(j) {
        const r = await j.cc.getListMainConnections({});
        if (!r || !ok(r.amError) || !Array.isArray(r.listConnections)) throw new Error('connections');
        return r.listConnections;
    }
    async function cleanup(j) {
        if (j.cleaning) return j.cleaning;
        j.cleaning = (async () => {
            clearInterval(j.timer);
            if (j.connection !== undefined) {
                // Never sweep a shared source. STOP is allowed only for our exact file.
                const list = await safe(() => connections(j));
                if (list && list.some((c) => c.mainConnectionID === j.connection && c.sourceID === sourceID && c.sinkID === sinkID)) {
                    const currentPath = await safe(() => j.mp.currentItemPath.getValue());
                    const names = Array.isArray(currentPath) ? currentPath.map((f) => f && f.name || '').join('/').replace(/\/+/g, '/') : '';
                    if (names === j.file || names === j.file.slice(1)) await safe(() => j.mp.sendButtonEvent({ button: 2, action: 0 }));
                    await safe(() => j.cc.disconnect({ mainConnectionID: j.connection }));
                }
            }
            for (const proxy of [j.mp, j.cc]) {
                const close = proxy && (proxy.shutdown || proxy.dispose);
                if (close) await safe(() => close.call(proxy));
            }
            if (job === j) job = null;
        })();
        return j.cleaning;
    }
    function stop(id) {
        const j = job;
        if (!j || (id && id !== j.id)) return Promise.resolve();
        j.cancelled = true;
        clearInterval(j.timer);
        return Promise.resolve(j.pending).then(() => cleanup(j), () => cleanup(j));
    }
    async function start(j) {
        try {
            j.cc = await builders.buildAndInitTypedProxy(controlName, '1', { timeoutMs: 4000 }); check(j);
            const sources = await j.cc.getListMainSources({}); check(j);
            const sinks = await j.cc.getListMainSinks({}); check(j);
            if (!sources || !ok(sources.amError) || !Array.isArray(sources.listMainSources) ||
                !sources.listMainSources.some((s) => s.sourceID === sourceID && s.name === 'OAPGenericMedia') ||
                !sinks || !ok(sinks.amError) || !Array.isArray(sinks.listMainSinks) ||
                !sinks.listMainSinks.some((s) => s.sinkID === sinkID && s.name === 'MediaSink_Front')) throw new Error('route');
            const list = await connections(j); check(j);
            if (list.some((c) => c.sourceID === sourceID)) throw new Error('busy');
            const connected = await j.cc.connect({ sourceID, sinkID });
            j.result = connected && connected.amError;
            // E_ALREADY_EXISTS belongs to somebody else, even if it appeared during our request.
            if (!connected || !ok(connected.amError) || !Number.isInteger(connected.mainConnectionID) || connected.mainConnectionID < 0 || connected.mainConnectionID > 65535) throw new Error('connect');
            j.connection = connected.mainConnectionID; check(j);
            j.result = undefined;
            // MGU21 may advertise the media player only after selecting its source.
            j.mp = await builders.buildAndInitTypedProxy(mediaName, 'OapGenericMedia', { timeoutMs: 4000 }); check(j);
            const state = await j.mp.playerState.getValue(); check(j);
            if (!idle(state)) throw new Error('busy');
            const played = await j.mp.playFile({ path: j.file, languageCode: 0x737061 });
            j.result = played && played.EntError;
            check(j);
            if (!played || (played.EntError !== 0 && played.EntError !== 'OK')) throw new Error('play');
            j.started = now(); j.lastProgress = now(); j.elapsed = -1;
            send(j, 'waiting');
            async function poll() {
                if (!active(j) || j.reading) return;
                j.reading = true;
                try {
                    const state = await j.mp.playerState.getValue(); check(j);
                    const time = await j.mp.currentItemTime.getValue(); check(j);
                    if (!time || !Number.isFinite(time.elapsed) || time.elapsed < 0 || time.elapsed > 32000 ||
                        !Number.isFinite(time.total) || time.total < 1000 || time.total > 32000) {
                        if (now() - j.started > 8000) throw new Error('clock');
                        return;
                    }
                    if (time.elapsed > j.elapsed) { j.lastProgress = now(); j.elapsed = time.elapsed; }
                    const playing = plays(state);
                    if (!playing && idle(state) && j.elapsed >= time.total - 1000) {
                        send(j, 'ended'); stop(j.id); return;
                    }
                    if (now() - j.lastProgress > 6000) throw new Error('clock');
                    send(j, playing ? 'playing' : 'paused', { elapsed: time.elapsed, total: time.total });
                } catch (error) {
                    if (active(j)) { send(j, 'error', { code: error.message === 'clock' ? 'clock' : 'read' }); stop(j.id); }
                } finally { j.reading = false; }
            }
            j.timer = setInterval(poll, 400); poll();
        } catch (error) {
            if (active(j)) send(j, 'error', { code: ['route', 'busy', 'connect', 'play', 'connections'].indexOf(error.message) >= 0 ? error.message : 'service',
                result: typeof j.result === 'number' || typeof j.result === 'string' ? String(j.result).slice(0,40) : undefined });
            j.cancelled = true;
        }
        if (!active(j)) await cleanup(j);
    }
    const watchdog = setInterval(() => {
        const j = job;
        if (j && (now() - j.heartbeat > 3500 || now() - j.created > 65000)) stop(j.id);
    }, 500);
    return {
        command(c) {
            if (closed || !c || !validId(c.id)) return false;
            if (c.op === 'stop') { stop(c.id); return true; }
            if (c.op === 'keepalive') { if (job && job.id === c.id) job.heartbeat = now(); return true; }
            if (c.op !== 'play' || c.path !== samplePath(c.id)) return false;
            if (job) { emit({ id: c.id, state: 'error', code: 'busy' }); return false; }
            const j = job = { id: c.id, file: c.path, created: now(), heartbeat: now() };
            j.pending = start(j);
            return true;
        },
        close() { closed = true; clearInterval(watchdog); return stop(); }
    };
}

module.exports = { createAudio, samplePath, validId };
