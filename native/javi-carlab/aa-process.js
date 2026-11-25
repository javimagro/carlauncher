'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { geometry, resolveGeometry, sameGeometry, mapInputPoint } = require('./aa-frame');
const videoId = 7;
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };

// Owns a worker generation and the UI's MGVF registration, not AA focus or input.
function createAAPlayer(gpu, options) {
    options = options || {};
    const now = options.now || monotonic;
    let capable = false, job, surface, displayedRing, counters, closing = [], cleanupError;
    function validRing(file) {
        return typeof file === 'string' && path.dirname(path.resolve(file)) === path.resolve(options.directory || '/dev/shm') &&
            /^mgu-video-bmwlauncher-[a-f0-9]{16}$/.test(path.basename(file));
    }
    function closeJob(current, preserveFrame) {
        if (!current) return Promise.resolve();
        if (current.closePromise) return current.closePromise;
        current.closed = true;
        clearInterval(current.lease);
        const keepRing = preserveFrame && current.ring === displayedRing;
        if (current.ring && !keepRing) fs.unlink(current.ring, () => {});
        if (!current.child) return (current.closePromise = Promise.resolve());
        current.closePromise = new Promise((resolve, reject) => {
            let finished = false, force, deadline;
            function complete(error) {
                if (finished) return;
                finished = true; clearTimeout(force); clearTimeout(deadline);
                if (error) reject(error); else resolve();
            }
            function onClose() {
                complete(current.closeAcknowledged && current.cleanExit ? null : new Error(current.closeError || 'worker-close-unconfirmed'));
            }
            if (current.processClosed) return onClose();
            current.child.once('close', onClose);
            force = setTimeout(() => { try { current.child.kill('SIGKILL'); } catch (_) {} }, 3500);
            deadline = setTimeout(() => complete(new Error('worker-close-timeout')), 4500);
            force.unref(); deadline.unref();
            if (current.child.connected) {
                try { current.child.send({ type: 'stop', preserveFrame: !!keepRing }, () => {}); } catch (_) {}
            }
        });
        const waiting = current.closePromise;
        closing.push(waiting);
        function remove() { const at = closing.indexOf(waiting); if (at >= 0) closing.splice(at, 1); }
        waiting.then(remove, error => { cleanupError = error; remove(); });
        return waiting;
    }
    function stop(settings) {
        const preserveFrame = !!(settings && settings.preserveFrame === true);
        const old = job, hadSurface = surface; job = undefined;
        if (!preserveFrame) {
            surface = counters = undefined;
            if (old || hadSurface) try { gpu.video(videoId, null); } catch (_) {}
            if (displayedRing) fs.unlink(displayedRing, () => {});
            displayedRing = undefined;
        }
        closeJob(old, preserveFrame);
        const result = Promise.all(closing.slice()).then(() => { if (cleanupError) throw cleanupError; });
        result.catch(() => {}); // Compatibility callers may ignore stop's result.
        return result;
    }
    function arm(session, changed, settings) {
        const previous = stop(settings), mustWait = closing.length > 0;
        changed = typeof changed === 'function' ? changed : () => {};
        if (!capable) { stop(); changed('unavailable', { code: 'renderer-video' }); return false; }
        if (cleanupError) { stop(); changed('error', { code: 'worker-close-unconfirmed' }); return false; }
        const current = { changed, closed: false, playing: false, configured: false }; job = current;
        const alive = () => job === current && !current.closed;
        function fail(code) { if (alive()) { stop(); changed('error', { code }); } }
        changed('starting');
        if (!alive()) return false;
        function begin() {
            if (!alive()) return;
            try {
                const child = (options.forkProcess || fork)(path.join(__dirname, 'aa-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
                current.child = child;
                const launchedAt = now();
                let lastContact;
                child.stderr.on('data', () => {});
                child.on('error', () => fail('worker-start'));
                child.once('close', (code, signal) => {
                    current.processClosed = true;
                    current.cleanExit = code === 0 && !signal;
                    // The final IPC status can arrive after exit but before close.
                    fail('worker-exit');
                });
                child.on('message', message => {
                    if (!message) return;
                    if (message.type === 'closed') {
                        current.closeAcknowledged = message.ok === true;
                        if (typeof message.error === 'string' &&
                            /^(capture-close-unconfirmed|capture-cleanup-pending|playback-close-timeout)$/.test(message.error))
                            current.closeError = message.error;
                        return;
                    }
                    if (!alive()) {
                        // A start already queued over IPC can create its ring after stop().
                        if ((message.type === 'ring' || message.type === 'video') && validRing(message.file) &&
                            (!current.ring || current.ring === message.file) && (!job || job.ring !== message.file)) {
                            current.ring = message.file;
                            if (message.file !== displayedRing) fs.unlink(message.file, () => {});
                        }
                        return;
                    }
                    if (['ring', 'video', 'status', 'stats'].indexOf(message.type) >= 0) lastContact = now();
                    if (message.type === 'ring' || message.type === 'video') {
                        if (!validRing(message.file) || (current.ring && current.ring !== message.file)) return fail('worker-ring');
                        current.ring = message.file;
                        if (message.type === 'video') {
                            if (!current.configured || !sameGeometry(message.geometry, current.geometry)) return fail('worker-geometry');
                            gpu.video(videoId, message.file);
                            surface = Object.freeze(Object.assign({ id: videoId, geometry: current.geometry }, current.geometry));
                            const previousRing = displayedRing; displayedRing = message.file;
                            if (previousRing && previousRing !== displayedRing) fs.unlink(previousRing, () => {});
                        }
                    } else if (message.type === 'status') {
                        if (message.status === 'error') { const detail = message.detail; stop(); changed('error', detail); }
                        else if (message.status === 'recovery-needed') { current.playing = false; changed('recovery-needed', message.detail); }
                        else if (['armed', 'playing'].indexOf(message.status) >= 0) {
                            current.playing = message.status === 'playing'; changed(message.status, message.detail);
                        }
                    } else if (message.type === 'stats') counters = message.value;
                });
                const send = message => {
                    if (!alive() || !child.connected) return;
                    try { child.send(message, error => { if (error) fail('worker-ipc'); }); }
                    catch (_) { fail('worker-ipc'); }
                };
                current.send = send;
                send({ type: 'arm', session, options: { ffmpeg: options.ffmpeg, capture: options.capture,
                    directory: options.directory, nativeCrop: options.nativeCrop } });
                if (current.configured) send({ type: 'configure', profile: current.profile });
                if (!alive()) return;
                current.lease = setInterval(() => {
                    const at = now();
                    // Child deadlines cannot fire while its loop is blocked.
                    // Expire its UI/input state independently, retaining a
                    // separate cold-start allowance before the first reply.
                    if (lastContact === undefined && at - launchedAt > 10000) return fail('worker-start-timeout');
                    if (lastContact !== undefined && at - lastContact > 2500) return fail('worker-stale');
                    send({ type: 'lease' });
                }, 250);
            } catch (_) { fail('worker-start'); }
        }
        if (mustWait) previous.then(begin, () => fail('worker-close-unconfirmed'));
        else begin();
        return true;
    }
    function configure(profile) {
        if (!job || job.closed || job.configured) return false;
        const selected = resolveGeometry(profile, options.nativeCrop), current = job;
        const boundary = profile && profile.setStartedNs;
        if (boundary !== undefined && (typeof boundary !== 'string' || !/^[1-9]\d{0,19}$/.test(boundary) ||
            (boundary.length === 20 && boundary > '18446744073709551615'))) throw new Error('geometry-frame-boundary');
        current.geometry = selected;
        current.profile = profile === undefined ? undefined : Object.assign({ display: 'MAIN', confirmed: true }, selected);
        if (boundary !== undefined) current.profile.setStartedNs = boundary;
        current.configured = true;
        if (current.send) current.send({ type: 'configure', profile: current.profile });
        return job === current && !current.closed;
    }
    function start(session, changed, profile, settings) {
        try { resolveGeometry(profile, options.nativeCrop); }
        catch (error) { if (changed) changed('error', { code: error.message }); return false; }
        return arm(session, changed, settings) && configure(profile);
    }
    return {
        ready(info) { capable = !!(info && info.video && gpu && typeof gpu.video === 'function'); if (!capable) stop(); },
        arm, configure, start, stop, stopAsync: stop, frame: () => surface, stats: () => counters,
        inputPoint: (rect, x, y, clamp) => surface && job && job.playing ? mapInputPoint(rect, x, y, clamp, surface.geometry) : null,
        geometry
    };
}

module.exports = { createAAPlayer, videoId, geometry, mapInputPoint };
