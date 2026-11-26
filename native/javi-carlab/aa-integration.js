'use strict';

const { execFile } = require('child_process');
const { createAAPlayer } = require('./aa-process');
const { createFocus } = require('./aa-focus');
const { resolveGeometry } = require('./aa-frame');
const { isLauncher } = require('./home-context');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
const diagnosticCode = value => typeof value === 'string' && /^[a-z0-9-]{1,48}$/.test(value) ? value : undefined;
// Real MAIN keyframes reached 72,717 bytes in the i4. The former 60 KiB
// starting window repeatedly interrupted acquisition; 120 KiB was exercised
// by the bounded recovery trial without incomplete or lost capture records.
const initialCapacity = 122880;

function inspect(capture) {
    return new Promise((resolve, reject) => {
        execFile(capture, ['--check'], { timeout: 5000, maxBuffer: 4096 }, (error, stdout, stderr) => {
            if (error) {
                for (const line of String(stderr || '').trim().split('\n').reverse()) {
                    try {
                        const status = JSON.parse(line);
                        if (status.type === 'error' && typeof status.code === 'string' && /^[a-z0-9-]{1,40}$/.test(status.code))
                            return reject(new Error('capture-' + status.code));
                    } catch (_) { /* Only bounded protocol codes reach the display. */ }
                }
                return reject(new Error('capture-unavailable'));
            }
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
    const log = options.log || console;
    const resolveProfile = options.resolveGeometryProfile;
    const createFormat = options.createFormat;
    if (resolveProfile !== undefined && typeof resolveProfile !== 'function') throw new Error('geometry-resolver');
    if (resolveProfile && options.geometryProfile !== undefined) throw new Error('geometry-resolver-conflict');
    if (createFormat !== undefined && typeof createFormat !== 'function') throw new Error('format-owner');
    if (createFormat && (resolveProfile || options.geometryProfile !== undefined)) throw new Error('format-owner-conflict');
    const initialGeometry = resolveGeometry(options.geometryProfile, options.nativeCrop);
    const initialProfile = options.geometryProfile === undefined ? undefined :
        Object.freeze(Object.assign({ display: 'MAIN', confirmed: true }, initialGeometry));
    const player = (options.createPlayer || createAAPlayer)(gpu, options);
    let listeners = [], shown = false, capable = false, closed = false;
    let epoch = 0, initialProfileUsed = false;
    let current, context, applet, contextAt = -Infinity, serial = Promise.resolve(), blocked, firstFailure, waiting = false, closing;
    let state = { state: 'unavailable', inputReady: false };
    function update(next, detail, failure) {
        state = { state: next, inputReady: false, detail: diagnosticCode(detail && detail.code) };
        if (failure) state.failure = failure;
        listeners.slice().forEach(fn => fn());
    }
    function reportBlocked() { update('error', { code: blocked }, firstFailure); }
    function requirement() {
        try { return options.requirement ? options.requirement() : null; }
        catch (_) { return 'aa-controls-unavailable'; }
    }
    function missingReadiness() {
        const age = now() - contextAt;
        return requirement() || (age >= 0 && age < 1600 && isLauncher(context, applet) ? null : 'context-unavailable');
    }
    function active(job) { return !closed && shown && capable && current === job && !job.cancelled; }
    function releaseFailure(code, error) {
        const cause = diagnosticCode(error && error.message);
        if (blocked !== code) log.warn('BMWLauncher AA: cierre ' + code + (cause ? ' · ' + cause : ''));
        blocked = code;
        // Failed restoration ends recovery: do not retain an unusable surface.
        safely(() => player.stop()).catch(() => {});
        reportBlocked();
    }
    function safely(work) { try { return Promise.resolve(work()); } catch (error) { return Promise.reject(error); } }
    function stopJob(preserveFrame) {
        const old = current; current = undefined;
        if (old) {
            old.cancelled = true;
            if (old.cancelGeometry) old.cancelGeometry();
            if (old.cancelReadiness) old.cancelReadiness();
        }
        const input = options.input ? safely(() => options.input.setVisible(false)).catch(() =>
            releaseFailure('input-stop-unconfirmed')) : Promise.resolve();
        // Cancel the format owner now, even if capture is still withdrawing.
        // Otherwise a pending acquisition could SET while shutdown is waiting.
        // Keep MAIN underlay until capture, format and input have withdrawn.
        const video = safely(() => player.stop({ preserveFrame: preserveFrame === true }))
            .catch(error => releaseFailure('capture-stop-unconfirmed', error));
        const format = old && old.format ? safely(() => old.format.close()).catch(() =>
            releaseFailure('format-restoration-unconfirmed')) : Promise.resolve();
        const finished = Promise.all([video, format, input]).then(() => old && old.focus ? old.focus.stop() : undefined)
            .catch(() => releaseFailure('focus-restoration-unconfirmed'));
        serial = Promise.all([serial, finished]).then(() => {});
        return serial;
    }
    function fail(job, code, errno) {
        if (!active(job)) return;
        code = diagnosticCode(code) || 'playback';
        firstFailure = code;
        const nativeError = Number.isInteger(errno) && errno > 0 && errno <= 4095 ? ' · errno ' + errno : '';
        log.warn('BMWLauncher AA: fallo ' + code + nativeError);
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
    async function configureFormat(job) {
        if (!active(job) || job.configuring) return;
        job.configuring = true;
        let deadline;
        const expires = now() + 4000;
        try {
            // The owner verifies native epoch/generation and rearms only after
            // observing restoration, on a new connection, before its own SET.
            job.format = createFormat({ onError: code => {
                // Also handle a factory that reports a failure synchronously.
                Promise.resolve().then(() => fail(job, code || 'format-lost'));
            } });
            if (!job.format || typeof job.format.acquire !== 'function' || typeof job.format.geometryProfile !== 'function' ||
                typeof job.format.close !== 'function') throw new Error('format-owner');
            const profile = await Promise.race([
                Promise.resolve().then(async () => {
                    if (!active(job)) throw new Error('geometry-cancelled');
                    const identity = Object.freeze(Object.assign({}, job.identity));
                    await job.format.acquire(identity);
                    if (!active(job)) throw new Error('geometry-cancelled');
                    return job.format.geometryProfile(identity);
                }),
                new Promise((resolve, reject) => {
                    job.cancelGeometry = () => reject(new Error('geometry-cancelled'));
                    deadline = setTimeout(() => reject(new Error('geometry-timeout')), 4000);
                })
            ]);
            if (!active(job)) return;
            if (now() >= expires) throw new Error('geometry-timeout');
            if (profile === undefined) throw new Error('geometry-unconfirmed');
            const selected = resolveGeometry(profile, options.nativeCrop);
            if (typeof profile.setStartedNs !== 'string' || !/^[1-9]\d{0,19}$/.test(profile.setStartedNs) ||
                (profile.setStartedNs.length === 20 && profile.setStartedNs > '18446744073709551615'))
                throw new Error('geometry-boundary');
            job.configured = true;
            if (player.configure(Object.freeze(Object.assign({ display: 'MAIN', confirmed: true }, selected,
                { setStartedNs: profile.setStartedNs }))) !== true)
                throw new Error('geometry-configure');
        } catch (error) { fail(job, error.code || error.message || 'format'); }
        finally { clearTimeout(deadline); job.cancelGeometry = undefined; }
    }
    function waitReady(job, missing = missingReadiness()) {
        if (!active(job)) return Promise.resolve(false);
        if (!missing) return Promise.resolve(true);
        if (job.readinessWait) return job.readinessWait;
        const limit = options.contextWaitMs || 4000, expires = now() + limit;
        job.readinessWait = new Promise(resolve => {
            const finish = value => {
                clearTimeout(timer); job.resumeReadiness = job.cancelReadiness = undefined;
                resolve(value);
            };
            const timeout = () => { finish(false); fail(job, missing); };
            const timer = setTimeout(timeout, limit);
            job.resumeReadiness = () => {
                if (!active(job)) return;
                if (now() >= expires) return timeout();
                const next = missingReadiness();
                if (!next) return finish(true);
                if (next !== missing) { missing = next; update('waiting', { code: missing }); }
            };
            job.cancelReadiness = () => finish(false);
        }).then(value => { job.readinessWait = undefined; return value; });
        update('waiting', { code: missing });
        return job.readinessWait;
    }
    function acquireFocus(job) {
        if (job.focus || job.focusStarting) return;
        const missing = missingReadiness();
        if (missing) {
            waitReady(job, missing).then(ready => { if (ready && active(job)) acquireFocus(job); });
            return;
        }
        job.focusStarting = true;
        update('armed');
        if (!active(job)) return;
        try {
            job.focus = (options.createFocus || createFocus)(applet, message => {
                if (!active(job)) return;
                if (message.state === 'error') fail(job, message.code);
                else if (message.state === 'ready') {
                    job.focusReady = true;
                    // A provider can report ready synchronously during creation;
                    // wait until its release handle belongs to this generation.
                    if (createFormat) Promise.resolve().then(() => configureFormat(job));
                    listeners.slice().forEach(fn => fn());
                }
            });
            if (!job.focus || typeof job.focus.stop !== 'function') throw new Error('focus-owner');
        } catch (_) { fail(job, 'focus-start'); }
    }
    async function launch(job) {
        await serial;
        if (!active(job)) return;
        if (blocked) { current = undefined; reportBlocked(); return; }
        firstFailure = undefined;
        try {
            const identity = await (options.inspect || inspect)(options.capture);
            if (!active(job)) return;
            const profile = createFormat ? undefined : await geometryProfile(job, identity);
            if (!active(job)) return;
            if (!await waitReady(job) || !active(job)) return;
            job.identity = Object.freeze(Object.assign({}, identity, { initialBytes: job.initialBytes }));
            const changed = (value, detail) => {
                if (!active(job)) return;
                if (value === 'armed') {
                    acquireFocus(job);
                } else if (value === 'recovery-needed') {
                    if (job.retries >= 2) return fail(job, 'recovery-exhausted');
                    const bytes = detail && detail.requiredBytes;
                    if (bytes !== undefined && (!Number.isInteger(bytes) || bytes < 1 || bytes > 262144)) return fail(job, 'capture-frame-limit');
                    const reason = diagnosticCode(detail && detail.code) || 'capture-gap';
                    log.warn('BMWLauncher AA: recuperación ' + reason + (bytes ? ' · bytes ' + bytes : ''));
                    stopJob(true);
                    // A newly requested keyframe can be larger than the one
                    // that triggered recovery. Grow with bounded headroom,
                    // rather than restarting once per slightly larger frame.
                    const capacity = bytes ? Math.min(262144, Math.max(bytes,
                        job.retries ? 262144 : job.initialBytes * 2)) : job.initialBytes;
                    const next = { retries: job.retries + 1, initialBytes: capacity, epoch: ++epoch };
                    current = next; update('recovery-needed', detail); launch(next);
                } else if (value === 'error' || value === 'unavailable') fail(job, detail && detail.code, detail && detail.errno);
                else if (value === 'playing') {
                    if (createFormat && (!job.focusReady || !job.configured)) return fail(job, 'geometry-not-configured');
                    update('playing');
                    // Input is enabled only by a verified transport, never by video alone.
                    if (active(job) && options.input) options.input.setVisible(true);
                } else update(value, detail);
            };
            const playback = { preserveFrame: job.retries > 0 };
            if (createFormat) player.arm(job.identity, changed, playback);
            else player.start(job.identity, changed, profile, playback);
        } catch (error) { fail(job, error.message || 'capture'); }
    }
    function start() {
        if (closed || !shown || !capable || current) return;
        if (blocked) { reportBlocked(); return; }
        const missing = missingReadiness();
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
            if (current && current.resumeReadiness) current.resumeReadiness();
            else if (waiting) start();
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
            if (closing) return closing;
            closed = true; shown = false; listeners = [];
            const release = stopJob();
            const input = options.input ? safely(() => options.input.close()).catch(() => releaseFailure('input-stop-unconfirmed')) : undefined;
            closing = Promise.all([release, input]).then(() => { if (blocked) throw new Error(blocked); });
            // UI owners may close without awaiting, but an awaiting supervisor
            // must still receive restoration/removal failure rather than success.
            closing.catch(() => {});
            return closing;
        }
    };
}

module.exports = { createIntegration, inspect };
