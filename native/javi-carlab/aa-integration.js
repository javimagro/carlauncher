'use strict';

const { execFile } = require('child_process');
const { createAAPlayer } = require('./aa-process');
const { createFocus } = require('./aa-focus');
const { resolveGeometry } = require('./aa-frame');
const { isLauncher } = require('./home-context');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
// Real MAIN keyframes reached 72,717 bytes in the i4. The former 60 KiB
// starting window repeatedly interrupted acquisition; 120 KiB was exercised
// by the bounded recovery trial without incomplete or lost capture records.
const initialCapacity = 122880;

function inspect(capture) {
    return new Promise((resolve, reject) => {
        execFile(capture, ['--check'], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => {
            if (error) return reject(new Error('capture-unavailable'));
            try {
                const value = JSON.parse(stdout);
                if (value.type !== 'checked' || !Number.isInteger(value.pid) || value.pid <= 1 ||
                    !/^\d{1,24}$/.test(value.starttime) || value.profile !== 'mgu21-aa-20261115') throw new Error('capture-profile');
                resolve(value);
            } catch (_) { reject(new Error('capture-profile')); }
        });
    });
}

// Coordinates bounded generations; the UI never owns capture buffers or BMW IPC.
function createIntegration(gpu, options) {
    options = Object.assign({}, options || {});
    const now = options.now || monotonic;
    const resolveProfile = options.resolveGeometryProfile;
    if (resolveProfile !== undefined && typeof resolveProfile !== 'function') throw new Error('geometry-resolver');
    if (resolveProfile && options.geometryProfile !== undefined) throw new Error('geometry-resolver-conflict');
    const initialGeometry = resolveGeometry(options.geometryProfile, options.nativeCrop);
    const initialProfile = options.geometryProfile === undefined ? undefined :
        Object.freeze(Object.assign({ display: 'MAIN', confirmed: true }, initialGeometry));
    const player = (options.createPlayer || createAAPlayer)(gpu, options);
    let listeners = [], shown = false, capable = false, closed = false;
    let epoch = 0, initialProfileUsed = false;
    let current, context, applet, contextAt = -Infinity, serial = Promise.resolve(), blocked, waiting = false;
    let state = { state: 'unavailable', inputReady: false };
    function update(next, detail) {
        state = { state: next, inputReady: false, detail: detail && detail.code };
        listeners.slice().forEach(fn => fn());
    }
    function requirement() {
        try { return options.requirement ? options.requirement() : null; }
        catch (_) { return 'aa-controls-unavailable'; }
    }
    function validContext() { return now() - contextAt < 1600 && isLauncher(context, applet); }
    function active(job) { return !closed && shown && capable && current === job && !job.cancelled; }
    function stopJob() {
        const old = current; current = undefined;
        if (old) {
            old.cancelled = true;
            if (old.cancelGeometry) old.cancelGeometry();
        }
        player.stop();
        if (options.input) options.input.setVisible(false);
        const release = old && old.focus ? old.focus.stop() : Promise.resolve();
        // Attach the rejection handler immediately; a previous generation may
        // still be draining. A failed restoration prevents every new acquisition.
        const finished = release.catch(() => {
            blocked = 'focus-restoration-unconfirmed';
            update('error', { code: blocked });
        });
        serial = serial.then(() => finished);
        return serial;
    }
    function fail(job, code) {
        if (!active(job)) return;
        stopJob(); update('error', { code });
    }
    async function geometryProfile(job, identity) {
        let profile;
        if (resolveProfile) {
            let deadline;
            const expires = now() + 4000;
            try {
                profile = await Promise.race([
                    Promise.resolve().then(() => {
                        if (!active(job)) throw new Error('geometry-cancelled');
                        return resolveProfile(Object.freeze(Object.assign({}, identity)), job.epoch);
                    }),
                    new Promise((resolve, reject) => {
                        job.cancelGeometry = () => reject(new Error('geometry-cancelled'));
                        deadline = setTimeout(() => reject(new Error('geometry-timeout')), 4000);
                    })
                ]);
                if (now() >= expires) throw new Error('geometry-timeout');
            } finally { clearTimeout(deadline); job.cancelGeometry = undefined; }
        } else if (initialProfile !== undefined) {
            // A confirmation supplied at construction belongs to one acquisition.
            // Reconnection/recovery needs geometry observed and confirmed in
            // that same session, not just an UpdateUiConfig callback.
            if (initialProfileUsed) throw new Error('geometry-confirmation-required');
            initialProfileUsed = true; profile = initialProfile;
        }
        const selected = resolveGeometry(profile, options.nativeCrop);
        return profile === undefined ? undefined : Object.freeze(Object.assign({ display: 'MAIN', confirmed: true }, selected));
    }
    async function launch(job) {
        await serial;
        if (!active(job)) return;
        if (blocked) { current = undefined; update('error', { code: blocked }); return; }
        try {
            const identity = await (options.inspect || inspect)(options.capture);
            if (!active(job)) return;
            const profile = await geometryProfile(job, identity);
            if (!active(job)) return;
            if (!validContext()) return fail(job, 'context-unavailable');
            identity.initialBytes = job.initialBytes;
            job.identity = identity;
            player.start(identity, (value, detail) => {
                if (!active(job)) return;
                if (value === 'armed') {
                    if (job.focus) return;
                    if (!validContext()) return fail(job, 'context-changed');
                    const missing = requirement();
                    if (missing) return fail(job, missing);
                    update('armed');
                    job.focus = (options.createFocus || createFocus)(applet, message => {
                        if (!active(job)) return;
                        if (message.state === 'error') fail(job, message.code);
                        else if (message.state === 'ready') listeners.slice().forEach(fn => fn());
                    });
                } else if (value === 'recovery-needed') {
                    if (job.retries >= 2) return fail(job, 'recovery-exhausted');
                    const bytes = detail && detail.requiredBytes;
                    if (bytes !== undefined && (!Number.isInteger(bytes) || bytes < 1 || bytes > 262144)) return fail(job, 'capture-frame-limit');
                    stopJob();
                    // A newly requested keyframe can be larger than the one
                    // that triggered recovery. Grow with bounded headroom,
                    // rather than restarting once per slightly larger frame.
                    const capacity = bytes ? Math.min(262144, Math.max(bytes,
                        job.retries ? 262144 : job.initialBytes * 2)) : job.initialBytes;
                    const next = { retries: job.retries + 1, initialBytes: capacity, epoch: ++epoch };
                    current = next; update('recovery-needed', detail); launch(next);
                } else if (value === 'error' || value === 'unavailable') fail(job, detail && detail.code || 'playback');
                else if (value === 'playing') {
                    update('playing');
                    // Input is enabled only by a verified transport, never by video alone.
                    if (options.input) options.input.setVisible(true);
                } else update(value, detail);
            }, profile);
        } catch (error) { fail(job, error.message || 'capture'); }
    }
    function start() {
        if (closed || !shown || !capable || current) return;
        if (blocked) { update('error', { code: blocked }); return; }
        const missing = requirement();
        waiting = !!missing;
        if (missing) {
            if (state.state !== 'waiting' || state.detail !== missing) update('waiting', { code: missing });
            return;
        }
        const job = { retries: 0, initialBytes: initialCapacity, epoch: ++epoch }; current = job;
        update('starting'); launch(job);
    }
    return {
        ready(info) { capable = !!(info && info.video); player.ready(info); if (!capable) stopJob(); else start(); },
        context(value, id) {
            context = value; applet = id; contextAt = now();
            if (waiting) start();
        },
        setVisible(value) {
            if (shown === !!value || closed) return;
            shown = !!value;
            if (shown) start(); else { stopJob(); update('unavailable'); }
        },
        status() {
            const ready = state.state === 'playing' && !!(options.input && options.input.ready());
            return Object.assign({}, state, { inputReady: ready });
        },
        frame: () => player.frame(), stats: () => player.stats(),
        touch(phase, point) { if (options.input && this.status().inputReady) return options.input.touch(phase, point); return false; },
        controller(event) {
            if (!options.input || !this.status().inputReady) return false;
            // With the original HMI context held, the selective FrontCCU gate
            // lets Hmi8 deliver rotary/press itself; never duplicate those keys.
            return typeof options.input.controller === 'function' ? options.input.controller(event) : true;
        },
        setInputFocus(on) { if (options.input) options.input.setFocus(on && this.status().inputReady); },
        changed(fn) { listeners.push(fn); return () => { listeners = listeners.filter(item => item !== fn); }; },
        close() {
            if (closed) return serial;
            closed = true; shown = false; listeners = [];
            const release = stopJob();
            return options.input ? Promise.all([release, options.input.close()]) : release;
        }
    };
}

module.exports = { createIntegration, inspect };
