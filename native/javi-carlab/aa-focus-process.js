'use strict';

const { fork } = require('child_process');
const { createSession } = require('./aa-control');
const { readContext, restoreFocus } = require('./aa-context');
const { isLauncher } = require('./home-context');
const { createLock, validIdentity } = require('./aa-focus-lock');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
const confirmed = value => ['restored', 'native-aa-retained', 'not-acquired'].indexOf(value) >= 0;

// The exclusive lock records the owner before authorizing PROJECTED. A failed
// restoration leaves it held, including after both processes have terminated.
async function run(applet, owner, options) {
    options = options || {};
    const proc = options.process || process, now = options.now || monotonic;
    const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    const repeat = options.setInterval || setInterval, cancelRepeat = options.clearInterval || clearInterval;
    const wait = options.wait || (ms => new Promise(resolve => later(resolve, ms)));
    const context = options.readContext || readContext, restore = options.restoreFocus || restoreFocus;
    const spawn = options.fork || fork;
    const send = value => { if (proc.connected) try { proc.send(value, () => {}); } catch (_) {} };
    if (!Number.isInteger(applet) || applet < 1 || !proc.send) throw new Error('arguments');
    const session = options.session || createSession(require('/usr/lib/someip.node'));
    const lock = options.lock || createLock();
    let token, stopping = false, connected = false, pending, finishPromise;
    let child, childClosed = false, childExited = false, lastLease = now(), timer, normalOwnerStop = false;
    let acquisition = 'not-attempted', ownerOutcome = 'unknown', registered = false;
    let grantResolve, grantTimer;
    const grant = new Promise(resolve => { grantResolve = resolve; });
    function childSend(message) {
        if (child && child.connected) try { child.send(Object.assign({ token }, message), () => {}); } catch (_) {}
    }
    function record(role) { return lock.verify(role); }
    async function finish(reason, fallback) {
        if (stopping) return finishPromise;
        stopping = true; cancelRepeat(timer); cancel(grantTimer); grantResolve(false);
        if (reason) send({ state: 'error', code: reason });
        finishPromise = (async () => {
            const deadline = later(() => {
                send({ state: 'closed', restoration: 'close-timeout', safe: false }); proc.exit(2);
            }, 12000);
            let restoration = 'not-acquired', safe = false;
            try {
                if (owner) {
                    if (pending) await pending.catch(() => {});
                    if (fallback && connected) {
                        const value = record('owner');
                        restoration = await restore(session, context, value.attempted);
                    } else restoration = 'delegated';
                    await session.close();
                    if (fallback && confirmed(restoration) && acquisition !== 'uncertain') safe = lock.release('owner');
                } else {
                    if (child && !childClosed) {
                        childSend({ op: 'stop' });
                        for (let n = 0; n < 35 && !childClosed; n++) await wait(100);
                        if (!childClosed && !childExited) {
                            // Signal only this supervisor's ChildProcess.
                            child.kill('SIGKILL');
                            for (let n = 0; n < 10 && !childClosed; n++) await wait(100);
                        }
                    }
                    const value = record('supervisor');
                    if (value.owner && lock.alive('owner')) throw new Error('owner-still-alive');
                    const attempted = value.attempted && ownerOutcome !== 'not-attempted';
                    if (connected) restoration = await restore(session, context, attempted);
                    else if (attempted) restoration = 'restore-unavailable';
                    await session.close();
                    // Killing an owner does not cancel a request already sent
                    // to BMW. Without its ACK, even a later NATIVE ACK cannot
                    // establish that an old PROJECTED request will not arrive.
                    if (confirmed(restoration) && (!attempted || ownerOutcome === 'acknowledged')) safe = lock.release('supervisor');
                }
            } catch (_) { restoration = 'restore-failed'; }
            send({ state: 'closed', restoration, safe, acquisition, token });
            cancel(deadline);
            later(() => proc.exit(owner && restoration === 'delegated' ? 0 : safe ? 0 : 2), 30);
        })();
        return finishPromise;
    }
    try {
        if (owner) {
            token = options.token || proc.argv[4];
            const identity = lock.join(token);
            send({ state: 'owner-started', token, identity });
        } else token = lock.acquire();
    } catch (error) {
        send({ state: 'error', code: error.code || 'focus-lock' });
        send({ state: 'closed', restoration: 'not-acquired', safe: false });
        proc.exit(2); return;
    }
    proc.once('disconnect', () => finish(undefined, owner && !normalOwnerStop));
    proc.once('SIGTERM', () => finish(undefined, owner && !proc.connected));
    proc.once('SIGINT', () => finish(undefined, owner && !proc.connected));
    proc.on('message', message => {
        if (!message || stopping || (owner && message.token !== token)) return;
        if (message.op === 'lease') lastLease = now();
        else if (message.op === 'stop') { normalOwnerStop = true; finish(); }
        else if (owner && message.op === 'acquire') {
            try { if (record('owner').attempted) grantResolve(true); }
            catch (_) { finish('focus-lock-owner', true); }
        }
    });
    timer = repeat(() => {
        if (now() - lastLease > 1500) finish('lease-expired', owner);
        else if (!owner && !stopping) childSend({ op: 'lease' });
    }, 250);
    try {
        await session.connect(); connected = true;
        if (stopping) { await session.close(); return; }
        if (owner) {
            const current = await context();
            if (stopping) return;
            if (!isLauncher(current, applet)) return finish('context-changed');
            send({ state: 'acquire-request', token });
            grantTimer = later(() => { grantResolve(false); finish('focus-grant-timeout'); }, 2500);
            const allowed = await grant; cancel(grantTimer);
            if (stopping || !allowed) return;
            record('owner');
            acquisition = 'uncertain';
            pending = session.focusProjected().then(() => {
                acquisition = 'acknowledged'; send({ state: 'acquisition', token, acquisition });
            });
            await pending;
            if (!stopping) send({ state: 'ready', token });
        } else {
            child = spawn(__filename, [String(applet), 'owner', token], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            child.on('message', message => {
                if (!message || message.token !== token) return;
                // Acquisition/closure acknowledgements remain relevant while
                // stopping; ignoring these would hide restoration uncertainty.
                if (message.state === 'acquisition' || message.state === 'closed') {
                    if (['not-attempted', 'acknowledged', 'uncertain'].indexOf(message.acquisition) >= 0) ownerOutcome = message.acquisition;
                }
                if (stopping) return;
                try {
                    if (message.state === 'owner-started') {
                        if (registered || !validIdentity(message.identity) || message.identity.pid !== child.pid) throw new Error('owner-identity');
                        lock.register(message.identity); registered = true;
                    } else if (message.state === 'acquire-request') {
                        if (!registered) throw new Error('owner-identity');
                        lock.authorize(); ownerOutcome = 'unknown'; childSend({ op: 'acquire' });
                    } else if (message.state === 'ready') send({ state: 'ready' });
                    else if (message.state === 'error') finish(message.code);
                } catch (_) { finish('focus-owner-identity'); }
            });
            child.on('error', () => finish('owner-start'));
            child.once('exit', () => { childExited = true; });
            child.once('close', () => { childClosed = true; if (!stopping) finish('owner-exit'); });
            childSend({ op: 'lease' });
        }
    } catch (_) { finish('focus-unavailable', owner && !proc.connected); }
}

if (require.main === module) run(Number(process.argv[2]), process.argv[3] === 'owner').catch(() => process.exit(1));
module.exports = { run, confirmed };
