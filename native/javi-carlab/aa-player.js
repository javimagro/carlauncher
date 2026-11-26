'use strict';

const { spawn } = require('child_process');
const { createRing } = require('./tdt-player');
const { createMux, maxFrame } = require('./aa-ts-mux');
const { resolveGeometry, createReader, cropFrame, nals, spsSize } = require('./aa-frame');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
const queueLimit = 2 * 1024 * 1024;

function boundaryParts(value) {
    if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) ||
        (value.length === 20 && value > '18446744073709551615')) throw new Error('geometry-frame-boundary');
    // Node 8 has no BigInt. Keep the native uint64 exact as two uint32 values.
    let high = 0, low = 0;
    for (let i = 0; i < value.length; i++) {
        const next = low * 10 + Number(value[i]);
        high = high * 10 + Math.floor(next / 4294967296); low = next % 4294967296;
    }
    return { high, low };
}
function beforeBoundary(record, boundary) {
    return record.high < boundary.high || (record.high === boundary.high && record.low < boundary.low);
}

// Runs only in aa-worker. The main UI receives paths/counters, never pixels.
function createPlayer(options, send) {
    options = options || {};
    const now = options.now || monotonic, launch = options.spawnProcess || spawn;
    const nativeCrop = options.nativeCrop !== false;
    // Validate a compatibility profile now, but allocate nothing until configure.
    resolveGeometry(options.geometryProfile, nativeCrop);
    let geometry;
    let stopped = false, started = false, capture, captureItem, decoder, ring, reader, timers = [], generation = 0, captureEnded = false;
    let armed = false, configured = false, playing = false, firstAt, configuredAt, lastPicture = 0, lastCapture = 0, blockedAt = 0;
    let outputAt = 0, output, cropped, queue = [], queued = 0, blocked = false;
    let pending = [], pendingBytes = 0, firstClock, lastClock = -Infinity, sps, pps, needsKey = true, nativeLines = '';
    let warm = [], warmBytes = 0, freshAfter, closing = Promise.resolve(), owned = [];
    const counters = { encoded: 0, decoded: 0, waitingKey: 0, preconfigureDropped: 0, reordered: 0, maxGapMs: 0, capture: {} };
    function emit(message) { if (!stopped) send(message); }
    function timer(fn, ms, repeat) { const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms); timers.push({ t, repeat }); return t; }
    function track(child) {
        const item = { child, closed: false };
        item.done = new Promise(resolve => { child.once('close', (code, signal) => {
            item.closed = true; item.code = code; item.signal = signal; resolve();
        }); });
        owned.push(item);
        return child;
    }
    function closeError(item) {
        if (item.cleanupError) return new Error('capture-cleanup-pending');
        // EOF/closed pipes are not evidence that an interrupted native capture
        // removed its probes. Only its cooperative, successful exit confirms it.
        // FFmpeg owns no probes and can be terminated after its pipes drain.
        const cleanRecovery = item.code === 75 && item.recoveryClosed;
        if (item.capture && ((item.code !== 0 && !cleanRecovery) || item.signal)) return new Error('capture-close-unconfirmed');
        return null;
    }
    function terminate(item, command) {
        const child = item.child;
        if (item.closed) { const error = closeError(item); return error ? Promise.reject(error) : item.done; }
        if (child.stdout) child.stdout.resume();
        if (child.stdin && !child.stdin.destroyed) { try { child.stdin.end(command); } catch (_) {} }
        return new Promise((resolve, reject) => {
            function signal(name) { if (!item.closed) try { child.kill(name); } catch (_) {} }
            const term = setTimeout(() => signal('SIGTERM'), 250);
            const kill = setTimeout(() => signal('SIGKILL'), 2000);
            const deadline = setTimeout(() => reject(new Error('playback-close-timeout')), 3000);
            term.unref(); kill.unref(); deadline.unref();
            item.done.then(() => {
                clearTimeout(term); clearTimeout(kill); clearTimeout(deadline);
                const error = closeError(item);
                if (error) reject(error); else resolve();
            });
        });
    }
    function releaseProcesses() {
        generation++;
        timers.forEach(item => item.repeat ? clearInterval(item.t) : clearTimeout(item.t)); timers = [];
        if (reader) reader.close();
        const processes = owned; owned = [];
        const previous = closing;
        closing = Promise.all([previous].concat(processes.map(item => terminate(item, item.child === capture ? 'stop\n' : undefined)))).then(() => {});
        closing.catch(() => {}); // Legacy callers may intentionally ignore stop's result.
        capture = decoder = undefined;
        queue = []; queued = 0; pending = []; pendingBytes = 0;
        warm = []; warmBytes = 0; sps = pps = undefined;
        output = cropped = null;
        return closing;
    }
    function stop(preserveFrame) {
        if (stopped) return closing;
        stopped = true; releaseProcesses();
        // Only the supervising UI may retain the file; it removes it when the
        // replacement frame arrives or the view closes. Always close our fd.
        if (ring) { try { ring.close(preserveFrame === true); } catch (_) {} ring = undefined; }
        return closing;
    }
    function fail(code, errno) {
        if (stopped) return;
        const detail = { code };
        if (Number.isInteger(errno) && errno > 0 && errno <= 4095) detail.errno = errno;
        send({ type: 'status', status: 'error', detail }); stop();
    }
    function recovery(detail) {
        if (stopped) return;
        releaseProcesses();
        // Keep the last complete image until the supervisor starts/stops the next generation.
        send({ type: 'status', status: 'recovery-needed', detail });
        armed = false;
    }
    function flushDecoder() {
        if (stopped || !decoder || blocked) return;
        while (queue.length) {
            const data = queue.shift(); queued -= data.length;
            if (!decoder.stdin.write(data)) { blocked = true; blockedAt = now(); return; }
        }
    }
    let mux;
    function enqueue(record) {
        const packet = mux(record.data, record.clock, record.flags);
        counters.encoded++; queue.push(packet); queued += packet.length;
        if (queued > queueLimit || queue.length > 256) return recovery({ code: 'decoder-backlog' });
        flushDecoder();
    }
    function consume(record) {
        if (stopped) return;
        if (record.discontinuity) return recovery({ code: 'capture-discontinuity' });
        if (record.clock < lastClock) return recovery({ code: 'capture-order' });
        lastClock = record.clock;
        const units = nals(record.data);
        if (!units.length) return fail('h264-annex-b');
        let key = false, hasSps = false, hasPps = false;
        units.forEach(unit => {
            if (unit.type === 7) {
                const size = spsSize(unit.payload);
                if (size.width !== 1920 || size.height !== 1080) throw new Error('video-profile');
                sps = Buffer.from(unit.bytes); hasSps = true;
            } else if (unit.type === 8) {
                if (unit.bytes.length > 4096) throw new Error('h264-pps');
                pps = Buffer.from(unit.bytes); hasPps = true;
            } else if (unit.type === 5) key = true;
        });
        if (needsKey && (!key || !sps || !pps)) { counters.waitingKey++; return; }
        let payload = record.data;
        if (needsKey || (!configured && key)) {
            payload = Buffer.concat([hasSps ? Buffer.alloc(0) : sps, hasPps ? Buffer.alloc(0) : pps, payload]);
            if (payload.length > maxFrame) return recovery({ code: 'decoder-frame-limit' });
            needsKey = false;
        }
        const value = { data: payload, clock: record.clock, flags: record.flags, high: record.high, low: record.low };
        if (configured) return enqueue(value);
        // Keep only the latest independently decodable GOP. If its bound is
        // exhausted, drain/discard until another IDR rather than keeping refs
        // to frames whose predecessor is gone or stopping native capture.
        if (key) { warm = []; warmBytes = 0; }
        warm.push(value); warmBytes += payload.length;
        if (warm.length > 128 || warmBytes > queueLimit) {
            counters.preconfigureDropped += warm.length;
            warm = []; warmBytes = 0; needsKey = true;
        }
    }
    function flushOrdered(force) {
        if (stopped || !reader) return;
        try {
            pending.sort((a, b) => a.high - b.high || a.low - b.low);
            const cutoff = now() - 35;
            while (pending.length && (force || pending[0].received <= cutoff)) {
                const record = pending.shift(); pendingBytes -= record.data.length;
                consume(record);
                if (stopped || !reader) return;
            }
        } catch (error) { fail(error.message === 'video-profile' ? 'video-profile' : 'invalid-video'); }
    }
    function receive(record) {
        const at = now(); lastCapture = at;
        // AAF1 frame_id and process.hrtime both use CLOCK_MONOTONIC on the MGU.
        // Ignore old frames even if they were still buffered in the native pipe
        // when configure arrived after the format acknowledgement.
        if (freshAfter !== undefined && beforeBoundary(record, freshAfter)) { counters.preconfigureDropped++; return; }
        if (!firstClock) firstClock = { high: record.high, low: record.low };
        record.clock = ((record.high - firstClock.high) * 4294967296 + record.low - firstClock.low) / 1000000;
        record.received = at;
        if (pending.length && record.clock < pending[pending.length - 1].clock) counters.reordered++;
        pending.push(record); pendingBytes += record.data.length;
        if (pending.length > 128 || pendingBytes > queueLimit) return recovery({ code: 'capture-backlog' });
    }
    function pixels(data, token) {
        if (stopped || token !== generation || !ring) return;
        try {
            for (let at = 0; at < data.length;) {
                const n = Math.min(output.length - outputAt, data.length - at);
                data.copy(output, outputAt, at, at + n); at += n; outputAt += n;
                if (outputAt !== output.length) continue;
                ring.push(nativeCrop ? output : cropFrame(output, cropped)); outputAt = 0;
                const atMs = now();
                if (lastPicture) counters.maxGapMs = Math.max(counters.maxGapMs, atMs - lastPicture);
                lastPicture = atMs; counters.decoded++;
                if (!playing) {
                    playing = true;
                    emit({ type: 'video', file: ring.file, geometry });
                    emit({ type: 'status', status: 'playing', detail: { firstFrameMs: Math.round(atMs - firstAt) } });
                }
            }
        } catch (_) { fail('video-ring'); }
    }
    function nativeMessage(message) {
        if (!message || typeof message.type !== 'string') return fail('capture-message');
        if (message.type === 'armed') {
            if (armed) return;
            armed = true; firstAt = now();
            emit({ type: 'status', status: 'armed' });
        } else if (message.type === 'recovery-needed') {
            const required = message.requiredBytes;
            recovery({ code: typeof message.code === 'string' ? message.code.slice(0, 80) : 'capture-gap',
                requiredBytes: Number.isInteger(required) && required > 0 && required <= maxFrame ? required : undefined, maxFrame });
        } else if (message.type === 'error') fail(typeof message.code === 'string' ? message.code.slice(0, 80) : 'capture', message.errno);
        else if (message.type === 'stats') {
            const value = {};
            Object.keys(message).slice(0, 32).forEach(key => { if (/^[a-zA-Z0-9_]{1,40}$/.test(key) && Number.isFinite(message[key])) value[key] = message[key]; });
            counters.capture = value;
        }
    }
    function configure(profile) {
        if (stopped || !started || configured || !capture || captureEnded) return false;
        const selected = resolveGeometry(profile, nativeCrop);
        const setBoundary = profile && profile.setStartedNs !== undefined ? boundaryParts(profile.setStartedNs) : undefined;
        geometry = selected; configured = true; configuredAt = now(); mux = createMux();
        if (profile !== undefined) {
            // v3 attests the native SET boundary, before its ACK. Keep an IDR
            // produced during that negotiation; another may not arrive soon.
            // Older attestations without that boundary conservatively require
            // a new IDR after configure. H264 has no margin metadata: this proves
            // temporal order, not visual completion of the phone's recomposition.
            if (setBoundary) freshAfter = setBoundary;
            else {
                const ns = Math.floor(configuredAt * 1000000) + 1;
                freshAfter = { high: Math.floor(ns / 4294967296), low: ns % 4294967296 };
            }
            if (warm.length && beforeBoundary(warm[0], freshAfter)) {
                counters.preconfigureDropped += warm.length; warm = []; warmBytes = 0;
            }
            const retained = pending.filter(record => !beforeBoundary(record, freshAfter));
            counters.preconfigureDropped += pending.length - retained.length;
            pending = retained; pendingBytes = pending.reduce((total, record) => total + record.data.length, 0);
            needsKey = warm.length === 0;
        }
        const frameBytes = geometry.width * geometry.height * 3 / 2;
        output = Buffer.alloc(nativeCrop ? frameBytes : geometry.decodedWidth * geometry.decodedHeight * 3 / 2);
        cropped = nativeCrop ? null : Buffer.alloc(frameBytes);
        const token = generation, active = () => !stopped && token === generation;
        try {
            ring = (options.createRing || createRing)(options.directory || '/dev/shm', geometry.width, geometry.height);
            emit({ type: 'ring', file: ring.file });
            decoder = track(launch(options.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'mpegts',
                '-probesize', '65536', '-analyzeduration', '0', '-i', 'pipe:0', '-an', '-fps_mode', 'passthrough',
                '-vf', nativeCrop ? 'fps=20,crop=' + [geometry.w, geometry.h, geometry.x, geometry.y].join(':') +
                    ',scale=' + geometry.width + ':' + geometry.height : 'fps=20,scale=' + geometry.decodedWidth + ':' + geometry.decodedHeight,
                '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] }));
            decoder.on('error', () => { if (active()) fail('decoder-start'); });
            decoder.on('close', () => { if (active()) fail('decoder-exit'); });
            decoder.stdout.on('data', data => pixels(data, token));
            decoder.stderr.on('data', () => {});
            decoder.stdin.on('error', () => { if (active()) fail('decoder-input'); });
            decoder.stdin.on('drain', () => { if (active()) { blocked = false; flushDecoder(); } });
            const buffered = warm; warm = []; warmBytes = 0;
            for (let i = 0; active() && i < buffered.length; i++) enqueue(buffered[i]);
            return active();
        } catch (_) { fail('playback-start'); return false; }
    }
    function arm(session) {
        if (started || stopped) return false;
        started = true;
        if (!session || !Number.isInteger(session.pid) || session.pid <= 1 || !/^\d{1,24}$/.test(String(session.starttime || '')) ||
            (session.profile && session.profile !== 'mgu21-aa-20261115')) return fail('capture-session');
        const bytes = session.initialBytes === undefined ? 61440 : session.initialBytes;
        if (!Number.isInteger(bytes) || bytes < 1 || bytes > maxFrame) return fail('capture-frame-limit');
        const token = ++generation;
        firstAt = now(); reader = createReader(session.pid, receive);
        try {
            const active = () => !stopped && token === generation;
            capture = track(launch(options.capture, ['--pid', String(session.pid), '--starttime', String(session.starttime), '--profile',
                'mgu21-aa-20261115', '--lease-ms', '1000', '--initial-bytes', String(bytes)], { stdio: ['pipe', 'pipe', 'pipe'] }));
            captureItem = owned[owned.length - 1]; captureItem.capture = true;
            capture.on('error', () => { if (active()) fail('capture-start'); });
            // 'close' follows drained stderr, preserving a final recovery-needed message.
            capture.on('close', () => { if (active()) fail('capture-exit'); });
            capture.stdin.on('error', () => { if (active()) fail('capture-lease'); });
            capture.stdout.on('data', data => { if (active()) try { reader.push(data); } catch (_) { fail('capture-frame'); } });
            capture.stdout.on('end', () => {
                if (!active()) return;
                captureEnded = true;
                try { reader.end(); flushOrdered(true); } catch (_) { return fail('capture-truncated'); }
                warm = []; warmBytes = 0;
                // Let final stderr explain a bounded recovery before reporting EOF.
                timer(() => { if (active()) fail('capture-eof'); }, 250, false);
            });
            capture.stderr.on('data', data => {
                // Keep draining bounded cleanup diagnostics after stop. The guard
                // inherits stderr, so child 'close' also waits for its pipe to end.
                if (data.length + nativeLines.length > 16384) {
                    nativeLines = '';
                    if (!active()) { captureItem.cleanupError = true; return; }
                    return fail('capture-status-limit');
                }
                nativeLines += data.toString('utf8');
                let at;
                while ((at = nativeLines.indexOf('\n')) >= 0) {
                    const line = nativeLines.slice(0, at); nativeLines = nativeLines.slice(at + 1);
                    if (!line) continue;
                    try {
                        const message = JSON.parse(line);
                        if (message && message.type === 'error' &&
                            ['cleanup-pending', 'guardian-cleanup-pending'].indexOf(message.code) >= 0) captureItem.cleanupError = true;
                        if (message && message.type === 'closed' && message.code === 'recovery-required') captureItem.recoveryClosed = true;
                        if (active()) nativeMessage(message);
                    } catch (_) { if (active()) fail('capture-status'); }
                }
            });
            const renew = () => { if (active() && capture && capture.stdin && !capture.stdin.destroyed) capture.stdin.write('lease\n'); };
            renew(); timer(renew, 250, true);
            timer(() => flushOrdered(false), 10, true);
            timer(() => {
                if (!active()) return;
                const at = now();
                if (!armed && at - firstAt > 8000) return fail('capture-timeout');
                if (armed && !configured && at - firstAt > 20000) return fail('configure-timeout');
                if (configured && !playing && at - configuredAt > 12000)
                    return fail(freshAfter !== undefined && needsKey ? 'video-keyframe-timeout' : 'video-timeout');
                if (playing && at - lastCapture > 4000) return fail('video-lost');
                if (blocked && at - blockedAt > 1500) return recovery({ code: 'decoder-stalled' });
            }, 250, true);
            timer(() => emit({ type: 'stats', value: stats() }), 1000, true);
            return true;
        } catch (_) { fail('playback-start'); }
        return false;
    }
    function start(session, profile) { if (!arm(session)) return false; return configure(profile === undefined ? options.geometryProfile : profile); }
    function stats() { return Object.assign({}, counters, { queuedBytes: queued, pendingBytes, warmBytes, warmFrames: warm.length }); }
    return { arm, configure, start, stop, stopAsync: stop, stats, get geometry() { return geometry; } };
}

module.exports = { createPlayer };
