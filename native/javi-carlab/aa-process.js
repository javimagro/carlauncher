'use strict';

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { geometry, resolveGeometry, sameGeometry, mapInputPoint } = require('./aa-frame');
const videoId = 7;

// Owns a worker generation and the UI's MGVF registration, not AA focus or input.
function createAAPlayer(gpu, options) {
    options = options || {};
    let capable = false, job, surface, counters;
    function validRing(file) {
        return typeof file === 'string' && path.dirname(path.resolve(file)) === path.resolve(options.directory || '/dev/shm') &&
            /^mgu-video-bmwlauncher-[a-f0-9]{16}$/.test(path.basename(file));
    }
    function closeJob(current) {
        if (!current || current.closed) return;
        current.closed = true;
        clearInterval(current.lease);
        if (current.child) {
            if (current.child.connected) {
                current.child.send({ type: 'stop' }, () => {});
                current.child.disconnect();
            }
            const force = setTimeout(() => { if (current.child.exitCode === null) current.child.kill('SIGKILL'); }, 3000);
            force.unref(); current.child.once('exit', () => clearTimeout(force));
        }
        if (current.ring) fs.unlink(current.ring, () => {});
    }
    function stop() {
        const old = job; job = undefined; surface = counters = undefined;
        if (old || surface) gpu.video(videoId, null);
        closeJob(old);
    }
    function start(session, changed, profile) {
        stop();
        changed = typeof changed === 'function' ? changed : () => {};
        if (!capable) { changed('unavailable', { code: 'renderer-video' }); return; }
        let selected;
        try { selected = resolveGeometry(profile, options.nativeCrop); }
        catch (error) { changed('error', { code: error.message }); return; }
        const current = { changed, closed: false, playing: false, geometry: selected }; job = current;
        const alive = () => job === current && !current.closed;
        function fail(code) { if (alive()) { stop(); changed('error', { code }); } }
        changed('starting');
        if (!alive()) return;
        try {
            const child = (options.forkProcess || fork)(path.join(__dirname, 'aa-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
            current.child = child;
            child.stderr.on('data', () => {});
            child.on('error', () => fail('worker-start'));
            child.on('exit', () => fail('worker-exit'));
            child.on('message', message => {
                if (!message) return;
                if (!alive()) {
                    // A start already queued over IPC can create its ring after stop().
                    if ((message.type === 'ring' || message.type === 'video') && validRing(message.file) &&
                        (!current.ring || current.ring === message.file) && (!job || job.ring !== message.file)) {
                        current.ring = message.file; fs.unlink(message.file, () => {});
                    }
                    return;
                }
                if (message.type === 'ring' || message.type === 'video') {
                    if (!validRing(message.file) || (current.ring && current.ring !== message.file)) return fail('worker-ring');
                    current.ring = message.file;
                    if (message.type === 'video') {
                        if (!sameGeometry(message.geometry, current.geometry)) return fail('worker-geometry');
                        gpu.video(videoId, message.file);
                        surface = Object.freeze(Object.assign({ id: videoId, geometry: current.geometry }, current.geometry));
                    }
                } else if (message.type === 'status') {
                    if (message.status === 'error') { const detail = message.detail; stop(); changed('error', detail); }
                    else if (message.status === 'recovery-needed') { current.playing = false; changed('recovery-needed', message.detail); }
                    else if (['armed', 'playing'].indexOf(message.status) >= 0) {
                        current.playing = message.status === 'playing'; changed(message.status, message.detail);
                    }
                } else if (message.type === 'stats') counters = message.value;
            });
            const send = message => { if (alive() && child.connected) child.send(message, error => { if (error) fail('worker-ipc'); }); };
            send({ type: 'start', session, options: { ffmpeg: options.ffmpeg, capture: options.capture,
                directory: options.directory, nativeCrop: options.nativeCrop,
                geometryProfile: profile === undefined ? undefined : Object.assign({ display: 'MAIN', confirmed: true }, selected) } });
            if (!alive()) return;
            current.lease = setInterval(() => send({ type: 'lease' }), 250);
        } catch (_) { fail('worker-start'); }
    }
    return {
        ready(info) { capable = !!(info && info.video && gpu && typeof gpu.video === 'function'); if (!capable) stop(); },
        start, stop, frame: () => surface, stats: () => counters,
        inputPoint: (rect, x, y, clamp) => surface && job && job.playing ? mapInputPoint(rect, x, y, clamp, surface.geometry) : null,
        geometry
    };
}

module.exports = { createAAPlayer, videoId, geometry, mapInputPoint };
