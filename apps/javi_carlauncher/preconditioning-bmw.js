'use strict';

const service = 'de.bmw.infotainment.drivingexcitement.PredictiveThermalManagement';
const feedback = { VWM_OFF_FEEDBACK: 0, VWM_MANUALON_FEEDBACK: 1, VWM_AUTO_FEEDBACK: 2, VWM_MANUALONAUTO_FEEDBACK: 3 };
const restrictions = { NO_RESTRICTIONS: 0, INSUFFICIENT_RANGE: 1, CHARGING_PROCESS: 2,
    INSUFFICIENT_RESIDUAL_RANGE: 3, CRITICAL_RANGE: 4, MAX_EFFICIENT_ACTIVE: 5 };
const code = (value, names, max) => Number.isInteger(value) && value >= 0 && value <= max ? value :
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(names, value) ? names[value] : null;
const safe = (fn) => Promise.resolve().then(fn).catch(() => undefined);
function createPreconditioning(builders, options) {
    options = options || {};
    const now = options.now || Date.now, every = options.every || setInterval, cancel = options.cancel || clearInterval;
    let proxy, subscription, stopped = false, connecting = false, reading = false, writing = false, writeStalled = false;
    let nextConnect = 0, serial = 0, sampledAt = 0, state = null, pending = null, result = null, requestId = null;
    const seen = new Set();
    function fresh() { return !stopped && !writeStalled && !!proxy && state && now() - sampledAt < 15000; }
    function receive(value) {
        if (stopped) return;
        const raw = value && value.statusVWM;
        state = value && { mode: code(value.statusFeedbackVWM, feedback, 3),
            restriction: code(value.statusRestrictionsVWM, restrictions, 5),
            active: Number.isInteger(raw) && raw >= 0 && raw < 61 ? !!(raw & 1) : null };
        sampledAt = now();
        if (!pending || !state) return;
        const confirmed = pending.enabled ? state.mode === pending.feedback : state.mode === 0 && state.active === false;
        if (confirmed) { pending = null; result = 'confirmed'; }
        else if (pending.enabled && state.restriction !== null && state.restriction !== 0) { pending = null; result = 'restricted'; }
    }
    async function read() {
        if (stopped || !proxy || reading) return;
        reading = true; const previous = serial;
        try { const value = await proxy.statusPredictiveThermalManagement.getValue(); if (serial === previous) receive(value); }
        catch (_) { /* A failed getter cannot replace a newer notifier or manufacture OFF. */ }
        finally { reading = false; }
    }
    async function connect() {
        if (stopped || connecting || proxy || now() < nextConnect) return;
        connecting = true; nextConnect = now() + 10000;
        try {
            const p = await builders.buildAndInitTypedProxy(service, '1', { timeoutMs: 8000 });
            if (stopped) { safe(() => p.dispose()); return; }
            if (!p.operationMode || typeof p.operationMode.setValue !== 'function') { safe(() => p.dispose()); return; }
            proxy = p;
            const attr = p.statusPredictiveThermalManagement;
            if (attr && typeof attr.subscribe === 'function') {
                safe(async () => {
                    const id = await attr.subscribe((value) => { serial++; receive(value); });
                    if (stopped) return safe(() => attr.unsubscribe(id));
                    subscription = { attr, id };
                });
            }
            read();
        } catch (_) { /* Reconnect while the app is visible; no command is ever replayed. */ }
        finally { connecting = false; }
    }
    function tick() {
        if (stopped) return;
        if (pending && now() - pending.at >= 12000) { pending = null; result = 'timeout'; writeStalled = writing; }
        if (!proxy) connect(); else read();
    }
    const ready = connect(), timer = every(tick, 2000);
    return { ready,
        async command(command) {
            if (stopped || !command || command.op !== 'precondition' || typeof command.enabled !== 'boolean' ||
                typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(command.id) || seen.has(command.id) || writing || pending) return false;
            seen.add(command.id); if (seen.size > 32) seen.delete(seen.values().next().value);
            requestId = command.id;
            if (!fresh() || state.mode === null || state.active === null) { result = 'unavailable'; return false; }
            if (command.enabled && state.restriction !== 0) { result = 'restricted'; return false; }
            // Hmi8 calcOperationCommandVWM: manual=2, automatic=1, both=3.
            // OFF deliberately deactivates the function, including preparation from a route.
            const mode = command.enabled ? (state.mode === 2 || state.mode === 3 ? 3 : 2) : 0;
            pending = { enabled: command.enabled, feedback: mode === 2 ? 1 : mode, at: now() };
            result = null; writing = true;
            // A getter already in flight before the command must not acknowledge it.
            serial++;
            try {
                await proxy.operationMode.setValue({ operationModeVWM: mode });
                if (!stopped) read();
                return !stopped;
            } catch (_) {
                if (!stopped && pending) { pending = null; result = 'error'; }
                return false;
            } finally { writing = false; writeStalled = false; }
        },
        snapshot() {
            const valid = fresh() && state.mode !== null && state.active !== null;
            return { available: !!valid, active: valid ? state.active : null, mode: valid ? state.mode : null,
                restriction: valid ? state.restriction : null, pending: !stopped && !writeStalled && (writing || !!pending), requestId, result };
        },
        stop() {
            if (stopped) return; stopped = true; cancel(timer); pending = null;
            if (subscription) safe(() => subscription.attr.unsubscribe(subscription.id));
            if (proxy) safe(() => proxy.dispose());
            // Closing the launcher does not change the vehicle's thermal mode.
        }
    };
}

function consumeCommands(receive) {
    let partial = '';
    return (chunk) => {
        if (chunk.length > 2048) return false;
        const text = chunk.toString('latin1');
        if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text)) return false;
        const lines = (partial + text).split('\n'); partial = lines.pop();
        if (partial.length > 1024 || lines.length > 8) return false;
        for (const line of lines) {
            if (line.length > 1024) return false;
            let command; try { command = JSON.parse(line); } catch (_) { return false; }
            if (!command || command.op !== 'precondition' || typeof command.enabled !== 'boolean' ||
                typeof command.id !== 'string' || !/^[a-zA-Z0-9_-]{1,40}$/.test(command.id)) return false;
            receive(command);
        }
        return true;
    };
}
module.exports = { createPreconditioning, consumeCommands, service };
