'use strict';

const { isLauncher, openContext } = require('./home-context');
const { isNativeAA } = require('./aa-context');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };

// Keep the original MAIN AA context below our root-owned layer. Hmi8 remains
// the input provider. If our UI/process disappears, original AA stays usable.
// Calls are serialized by the service's existing HMI polling loop.
function createUnderlay(options) {
    const now = options.now || monotonic;
    let job, context, contextAt = -Infinity, lastApplet, busy = false;
    function settle(current, error) {
        clearTimeout(current.deadline);
        if (job === current) job = undefined;
        if (error) current.reject(error); else current.resolve();
    }
    function abandon() {
        if (!job) return;
        const old = job; old.abandoned = true;
        settle(old);
    }
    function acquire(applet, changed) {
        if (busy || job || applet !== lastApplet || now() - contextAt > 1600 || !isLauncher(context, applet)) {
            changed({ state: 'error', code: 'aa-context-unavailable' });
            return { stop: () => Promise.resolve() };
        }
        let resolve, reject;
        const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
        // The caller attaches its release handler later when capture stops.
        finished.catch(() => {});
        const current = { applet, origin: context, phase: 'pending', changed, resolve, reject, finished };
        job = current;
        return { stop() {
            if (current.abandoned || job !== current) return finished;
            if (!current.leaving) {
                current.leaving = true;
                if (current.phase === 'pending') settle(current);
                else current.deadline = setTimeout(() => {
                    if (job === current) settle(current, new Error('aa-context-restore-timeout'));
                }, 6500);
            }
            return finished;
        } };
    }
    async function poll(value, applet, closingOnly) {
        context = value; contextAt = now(); lastApplet = applet;
        if (busy || !job) return;
        const current = job;
        if (closingOnly && !current.leaving) return;
        if (!value) { abandon(); return; }
        if (current.leaving) {
            // The open ACK can precede Hmi8's context change. Seeing the old
            // launcher again does not prove that a cancelled open stayed put.
            if (current.phase === 'opening' && isLauncher(value, current.applet)) {
                if (now() < current.until) return;
                settle(current, new Error('aa-context-open-unconfirmed'));
                return;
            }
            if (current.phase === 'returning') {
                if (!isNativeAA(value)) settle(current);
                return;
            }
            // Never overwrite a context chosen by the user after our AA view.
            if (!isNativeAA(value)) { settle(current); return; }
            busy = true; current.phase = 'returning';
            try {
                const reply = await options.request(openContext(current.origin));
                if (job === current && !/^ok(?:\s|$)/.test(reply)) settle(current, new Error('aa-context-restore'));
            } catch (error) { if (job === current) settle(current, error); }
            finally { busy = false; }
            return;
        }
        if (current.phase === 'pending') {
            if (!isLauncher(value, current.applet) || !options.allowed()) {
                current.changed({ state: 'error', code: 'aa-context-changed' }); return;
            }
            busy = true; current.phase = 'opening'; current.until = now() + 3500;
            // Refresh the OAP lease before Hmi8 hides the launcher's RHMI page.
            if (options.beforeOpen) options.beforeOpen();
            try {
                const reply = await options.request('open 1 50');
                if (job === current && !/^ok(?:\s|$)/.test(reply)) current.changed({ state: 'error', code: 'aa-context-open' });
            } catch (_) { if (job === current) current.changed({ state: 'error', code: 'aa-context-open' }); }
            finally { busy = false; }
        } else if (current.phase === 'opening' && isNativeAA(value)) {
            current.phase = 'held'; current.changed({ state: 'ready' });
        } else if (current.phase === 'opening' && isLauncher(value, current.applet) && now() < current.until) {
            return;
        } else if (!isNativeAA(value)) {
            abandon(); current.changed({ state: 'error', code: 'aa-context-lost' });
        }
    }
    return {
        acquire, poll, abandon,
        owns: value => !!job && job.phase !== 'pending' && isNativeAA(value),
        holding: () => !!job,
        inputReady: () => !!job && job.phase === 'held' && !job.leaving &&
            now() - contextAt < 800 && isNativeAA(context)
    };
}

module.exports = { createUnderlay };
