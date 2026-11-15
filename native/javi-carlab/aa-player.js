'use strict';

const { spawn } = require('child_process');
const { createRing } = require('./tdt-player');
const { createMux, maxFrame } = require('./aa-ts-mux');
const { resolveGeometry, createReader, cropFrame, nals, spsSize } = require('./aa-frame');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
const queueLimit = 2 * 1024 * 1024;

// Runs only in aa-worker. The main UI receives paths/counters, never pixels.
function createPlayer(options, send) {
    options = options || {};
    const now = options.now || monotonic, launch = options.spawnProcess || spawn;
    const nativeCrop = options.nativeCrop !== false;
    const geometry = resolveGeometry(options.geometryProfile, nativeCrop);
    const frameBytes = geometry.width * geometry.height * 3 / 2;
    const decodedBytes = geometry.decodedWidth * geometry.decodedHeight * 3 / 2;
    let stopped = false, started = false, capture, decoder, ring, reader, timers = [], generation = 0;
    let armed = false, playing = false, firstAt, lastPicture = 0, lastCapture = 0, blockedAt = 0;
    let outputAt = 0, output = Buffer.alloc(nativeCrop ? frameBytes : decodedBytes), cropped = nativeCrop ? null : Buffer.alloc(frameBytes), queue = [], queued = 0, blocked = false;
    let pending = [], pendingBytes = 0, firstClock, lastClock = -Infinity, sps, pps, needsKey = true, nativeLines = '';
    const counters = { encoded: 0, decoded: 0, waitingKey: 0, reordered: 0, maxGapMs: 0, capture: {} };
    function emit(message) { if (!stopped) send(message); }
    function timer(fn, ms, repeat) { const t = repeat ? setInterval(fn, ms) : setTimeout(fn, ms); timers.push({ t, repeat }); return t; }
    function terminate(child, command) {
        if (!child) return;
        if (child.stdout) child.stdout.resume();
        if (child.stdin && !child.stdin.destroyed) { try { child.stdin.end(command); } catch (_) {} }
        const term = setTimeout(() => { if (child.exitCode === null) child.kill('SIGTERM'); }, 250);
        const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2000);
        term.unref(); kill.unref();
        child.once('exit', () => { clearTimeout(term); clearTimeout(kill); });
    }
    function releaseProcesses() {
        generation++;
        timers.forEach(item => item.repeat ? clearInterval(item.t) : clearTimeout(item.t)); timers = [];
        if (reader) reader.close();
        terminate(capture, 'stop\n'); terminate(decoder);
        capture = decoder = undefined;
        queue = []; queued = 0; pending = []; pendingBytes = 0;
        output = cropped = null;
    }
    function stop() {
        if (stopped) return;
        stopped = true; releaseProcesses();
        if (ring) { try { ring.close(); } catch (_) {} ring = undefined; }
    }
    function fail(code) {
        if (stopped) return;
        send({ type: 'status', status: 'error', detail: { code } }); stop();
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
    function consume(record) {
        if (stopped || !decoder) return;
        if (record.discontinuity) return recovery({ code: 'capture-discontinuity' });
        if (record.clock < lastClock) return recovery({ code: 'capture-order' });
        lastClock = record.clock;
        const units = nals(record.data);
        if (!units.length) return fail('h264-annex-b');
        let key = false, hasSps = false, hasPps = false;
        units.forEach(unit => {
            if (unit.type === 7) {
                const size = spsSize(unit.payload);
                if (size.width !== geometry.videoWidth || size.height !== geometry.videoHeight) throw new Error('video-profile');
                sps = Buffer.from(unit.bytes); hasSps = true;
            } else if (unit.type === 8) {
                if (unit.bytes.length > 4096) throw new Error('h264-pps');
                pps = Buffer.from(unit.bytes); hasPps = true;
            } else if (unit.type === 5) key = true;
        });
        if (needsKey && (!key || !sps || !pps)) { counters.waitingKey++; return; }
        let payload = record.data;
        if (needsKey) {
            payload = Buffer.concat([hasSps ? Buffer.alloc(0) : sps, hasPps ? Buffer.alloc(0) : pps, payload]);
            if (payload.length > maxFrame) return recovery({ code: 'decoder-frame-limit' });
            needsKey = false;
        }
        const packet = mux(payload, record.clock, record.flags);
        counters.encoded++; queue.push(packet); queued += packet.length;
        if (queued > queueLimit || queue.length > 256) return recovery({ code: 'decoder-backlog' });
        flushDecoder();
    }
    function flushOrdered(force) {
        if (stopped || !decoder) return;
        try {
            pending.sort((a, b) => a.high - b.high || a.low - b.low);
            const cutoff = now() - 35;
            while (pending.length && (force || pending[0].received <= cutoff)) {
                const record = pending.shift(); pendingBytes -= record.data.length;
                consume(record);
                if (stopped || !decoder) return;
            }
        } catch (error) { fail(error.message === 'video-profile' ? 'video-profile' : 'invalid-video'); }
    }
    function receive(record) {
        const at = now(); lastCapture = at;
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
        } else if (message.type === 'error') fail(typeof message.code === 'string' ? message.code.slice(0, 80) : 'capture');
        else if (message.type === 'stats') {
            const value = {};
            Object.keys(message).slice(0, 32).forEach(key => { if (/^[a-zA-Z0-9_]{1,40}$/.test(key) && Number.isFinite(message[key])) value[key] = message[key]; });
            counters.capture = value;
        }
    }
    function start(session) {
        if (started || stopped) return;
        started = true;
        if (!session || !Number.isInteger(session.pid) || session.pid <= 1 || !/^\d{1,24}$/.test(String(session.starttime || '')) ||
            (session.profile && session.profile !== 'mgu21-aa-20261115')) return fail('capture-session');
        const bytes = session.initialBytes === undefined ? 61440 : session.initialBytes;
        if (!Number.isInteger(bytes) || bytes < 1 || bytes > maxFrame) return fail('capture-frame-limit');
        const token = ++generation;
        firstAt = now(); mux = createMux(); reader = createReader(session.pid, receive);
        try {
            ring = (options.createRing || createRing)(options.directory || '/dev/shm', geometry.width, geometry.height);
            emit({ type: 'ring', file: ring.file });
            decoder = launch(options.ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-threads', '1', '-f', 'mpegts',
                '-probesize', '65536', '-analyzeduration', '0', '-i', 'pipe:0', '-an', '-fps_mode', 'passthrough',
                '-vf', nativeCrop ? 'fps=20,crop=' + [geometry.w, geometry.h, geometry.x, geometry.y].join(':') +
                    ',scale=' + geometry.width + ':' + geometry.height : 'fps=20,scale=' + geometry.decodedWidth + ':' + geometry.decodedHeight,
                '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
            const active = () => !stopped && token === generation;
            decoder.on('error', () => { if (active()) fail('decoder-start'); });
            decoder.on('close', () => { if (active()) fail('decoder-exit'); });
            decoder.stdout.on('data', data => pixels(data, token));
            decoder.stderr.on('data', () => {});
            decoder.stdin.on('error', () => { if (active()) fail('decoder-input'); });
            decoder.stdin.on('drain', () => { if (active()) { blocked = false; flushDecoder(); } });
            capture = launch(options.capture, ['--pid', String(session.pid), '--starttime', String(session.starttime), '--profile',
                'mgu21-aa-20261115', '--lease-ms', '1000', '--initial-bytes', String(bytes)], { stdio: ['pipe', 'pipe', 'pipe'] });
            capture.on('error', () => { if (active()) fail('capture-start'); });
            // 'close' follows drained stderr, preserving a final recovery-needed message.
            capture.on('close', () => { if (active()) fail('capture-exit'); });
            capture.stdin.on('error', () => { if (active()) fail('capture-lease'); });
            capture.stdout.on('data', data => { if (active()) try { reader.push(data); } catch (_) { fail('capture-frame'); } });
            capture.stdout.on('end', () => { if (active()) try { reader.end(); flushOrdered(true); } catch (_) { fail('capture-truncated'); } });
            capture.stderr.on('data', data => {
                if (!active()) return;
                if (data.length + nativeLines.length > 16384) return fail('capture-status-limit');
                nativeLines += data.toString('utf8');
                let at;
                while ((at = nativeLines.indexOf('\n')) >= 0) {
                    const line = nativeLines.slice(0, at); nativeLines = nativeLines.slice(at + 1);
                    if (!line) continue;
                    try { nativeMessage(JSON.parse(line)); } catch (_) { fail('capture-status'); }
                    if (!active()) return;
                }
            });
            const renew = () => { if (active() && capture && capture.stdin && !capture.stdin.destroyed) capture.stdin.write('lease\n'); };
            renew(); timer(renew, 250, true);
            timer(() => flushOrdered(false), 10, true);
            timer(() => {
                if (!active()) return;
                const at = now();
                if (!armed && at - firstAt > 8000) return fail('capture-timeout');
                if (armed && !playing && at - firstAt > 12000) return fail('video-timeout');
                if (playing && at - lastCapture > 4000) return fail('video-lost');
                if (blocked && at - blockedAt > 1500) return recovery({ code: 'decoder-stalled' });
            }, 250, true);
            timer(() => emit({ type: 'stats', value: Object.assign({}, counters, { queuedBytes: queued, pendingBytes }) }), 1000, true);
        } catch (_) { fail('playback-start'); }
    }
    return { start, stop, stats: () => Object.assign({}, counters), geometry };
}

module.exports = { createPlayer };
