'use strict';

const path = require('path');
const { fork } = require('child_process');
const { mapFramePoint } = require('./aa-input');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };

function createInput(options) {
    options = options || {};
    const now = options.now || monotonic, spawn = options.fork || fork;
    const later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
    const worker = path.join(__dirname, 'aa-input-worker.js');
    let enabled = false, visible = false, focused = false, closed = false, blocked = false;
    let current, heartbeat, closingPromise, cleanupError;
    function allowed() {
        try { return typeof options.allowed === 'function' && options.allowed() === true; }
        catch (_) { return false; }
    }
    function error(code) {
        blocked = true;
        if (typeof options.onError === 'function') try { options.onError(code); } catch (_) {}
    }
    function signal(child) { try { child.kill('SIGKILL'); } catch (_) {} }
    function recover(point) {
        return new Promise(resolve => {
            let child, timer, deadline, released = false, ended = false;
            function finish(ok) {
                if (ended) return;
                ended = true; clear(timer); clear(deadline);
                resolve(ok);
            }
            try {
                child = spawn(worker, ['--release'], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
                child.on('message', message => { if (message && message.op === 'released') released = true; });
                child.on('error', () => { signal(child); finish(false); });
                // The exit event can precede the final IPC message.
                child.once('close', code => finish(code === 0 && released));
                timer = later(() => signal(child), 500);
                deadline = later(() => finish(false), 750);
                if (child.send({ op: 'release', point }, err => { if (err) { signal(child); finish(false); } }) === false) {
                    signal(child); finish(false);
                }
            } catch (_) { finish(false); }
        });
    }
    function finish(job, exited) {
        if (job.ended) return;
        job.ended = true; job.ready = false; clear(job.kill); clear(job.deadline);
        const point = job.confirmed || job.possible;
        // Drain IPC before deciding whether the original sender delivered UP.
        const release = exited && point ? recover(point) : Promise.resolve(exited);
        release.then(ok => {
            if (!ok) {
                const code = exited ? 'input-release-unconfirmed' : 'input-worker-stop-timeout';
                cleanupError = new Error(code);
                error(code);
            }
            if (current === job) current = undefined;
            if (ok) job.resolve(); else job.reject(cleanupError);
            reconcile();
        });
    }
    function stop(job, reason) {
        if (!job || job.ended || job.stopping) return;
        if (reason) error(reason);
        job.stopping = true; job.ready = false; job.finger = false; job.queue = [];
        job.kill = later(() => signal(job.child), 350);
        job.deadline = later(() => finish(job, false), 750);
        if (job.child.connected) {
            try { job.child.send({ op: 'stop' }, () => {}); } catch (_) { signal(job.child); }
        } else signal(job.child);
    }
    function send(job, message) {
        if (job.ended || job.stopping || !job.child.connected) { stop(job, 'input-disconnected'); return false; }
        try {
            if (job.child.send(message, err => { if (err) stop(job, 'input-ipc'); }) === false) {
                stop(job, 'input-backpressure'); return false;
            }
            return true;
        } catch (_) { stop(job, 'input-ipc'); return false; }
    }
    function flush(job) {
        if (job.flight || !job.queue.length || job.stopping || job.ended) return;
        const value = job.queue.shift();
        if (!allowed() || !enabled || !visible || !focused) { cancel(); return; }
        value.id = ++job.command; job.flight = value;
        // Retain the attempted down as well as acknowledged UDP coordinates:
        // a worker may die between sending UDP and reporting its completion.
        if (value.phase === 'down') job.possible = mapFramePoint(value.point);
        send(job, Object.assign({ op: 'touch' }, value));
    }
    function start() {
        const job = { seq: 0, ack: 0, at: now(), command: 0, queue: [], ready: false };
        job.finished = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
        job.finished.catch(() => {}); // A visibility transition may occur without an awaiting caller.
        current = job;
        try {
            // Separate process group: killing the UI's group must leave time
            // for the worker's disconnect/lease handler to send its final up.
            job.child = spawn(worker, [], { detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            job.child.on('message', message => {
                if (job.ended || !message) return;
                if (message.op === 'sent') {
                    const p = message.point;
                    if (!p || !Number.isInteger(p.x) || !Number.isInteger(p.y) || p.x < 120 || p.x >= 2880 || p.y < 0 || p.y >= 840) return;
                    if (message.event === 3) job.confirmed = job.possible = undefined;
                    else if (message.event === 1 || message.event === 2) job.confirmed = { x: p.x, y: p.y };
                } else if (message.op === 'ready' && !job.stopping) {
                    if (!Number.isSafeInteger(message.seq) || message.seq <= job.ack || message.seq > job.seq) return;
                    const at = now(), first = job.ack === 0, elapsed = at - job.at;
                    if (first && elapsed >= 2000) return stop(job, 'input-worker-start-timeout');
                    job.ack = message.seq; job.at = at; job.ready = message.ready === true;
                    if (first && typeof options.onTiming === 'function') {
                        try { options.onTiming({ event: 'first-ack', elapsedMs: Math.round(elapsed), ready: job.ready }); } catch (_) {}
                    }
                    if (!job.ready) stop(job, 'input-unavailable');
                } else if (message.op === 'ack' && job.flight && message.id === job.flight.id) {
                    job.flight = undefined;
                    if (message.accepted !== true) stop(job, 'input-rejected');
                    else flush(job);
                } else if (message.op === 'closed') {
                    job.ready = false;
                    if (message.reason && !job.stopping) error('input-worker-' + message.reason);
                }
            });
            job.child.on('error', () => stop(job, 'input-worker'));
            job.child.once('close', () => {
                if (!job.stopping) error('input-worker-exit');
                finish(job, true);
            });
        } catch (_) { error('input-start'); finish(job, true); }
    }
    function reconcile() {
        clear(heartbeat); heartbeat = undefined;
        if (closed || !enabled || !visible || blocked) { stop(current); return; }
        heartbeat = later(reconcile, 250);
        if (!allowed()) { stop(current); return; }
        if (!current) start();
        const job = current;
        if (!job || job.stopping || job.ended) return;
        // Cold process startup has its own deadline. No touch is admitted
        // before its first ACK; the active worker lease remains 700 ms.
        if (now() - job.at >= (job.ack ? 700 : 2000)) {
            return stop(job, job.ack ? 'input-worker-unresponsive' : 'input-worker-start-timeout');
        }
        send(job, { op: 'lease', seq: ++job.seq, focus: focused });
    }
    function ready() {
        return !closed && !blocked && enabled && visible && allowed() && !!current &&
            !current.stopping && !current.ended && current.ready && now() - current.at < 700;
    }
    function cancel() {
        const job = current;
        if (!job || job.stopping || job.ended) return;
        if (job.cancelPending || (!job.finger && !job.flight && !job.possible && !job.confirmed)) return;
        job.cancelPending = true;
        job.finger = false; job.queue = [];
        send(job, { op: 'cancel' });
    }
    function touch(phase, point) {
        if (phase === 'cancel') { cancel(); return true; }
        if (['down', 'move', 'up'].indexOf(phase) < 0) return false;
        if (!ready() || !focused || !mapFramePoint(point)) { cancel(); return false; }
        const job = current;
        if (phase === 'down') {
            if (job.finger) cancel();
            if (job.flight || job.queue.length || job.possible || job.confirmed) return false;
            job.finger = true; job.cancelPending = false;
        } else if (!job.finger) return false;
        if (phase === 'up') job.finger = false;
        job.queue = job.queue.filter(item => item.phase !== 'move');
        job.queue.push({ phase, point: { x: point.x, y: point.y } });
        flush(job); return !job.stopping;
    }
    function close() {
        if (closingPromise) return closingPromise;
        closed = true; enabled = false; clear(heartbeat); heartbeat = undefined;
        const job = current; stop(job);
        closingPromise = job ? job.finished : withdrawal();
        return closingPromise;
    }
    function withdrawal() {
        if (current) return current.finished;
        if (!cleanupError) return Promise.resolve();
        const result = Promise.reject(cleanupError);
        result.catch(() => {});
        return result;
    }
    return {
        ready, touch, cancel, close,
        enable(value) { if (enabled === (value === true)) return; enabled = value === true; if (!enabled) cancel(); reconcile(); },
        setVisible(value) {
            const next = value === true;
            if (visible !== next) {
                visible = next;
                if (!visible) cancel();
                else if (!cleanupError) blocked = false;
                reconcile();
            }
            if (!visible) return withdrawal();
        },
        setFocus(value) { if (focused === (value === true)) return; focused = value === true; if (!focused) cancel(); reconcile(); },
        controller() { return false; }
    };
}
module.exports = { createInput };
