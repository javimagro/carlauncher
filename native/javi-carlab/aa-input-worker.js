'use strict';

const { createInput, touchPdu } = require('./aa-input');
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };

function run(options) {
    options = options || {};
    const proc = options.process || process, now = options.now || monotonic;
    const later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
    let lease = -Infinity, sequence = 0, command = 0, stopping = false, watch, ending;
    const started = now();
    function send(message) { if (proc.connected) try { proc.send(message, () => {}); } catch (_) {} }
    const input = (options.createInput || createInput)(Object.assign({}, options, {
        allowed: () => !stopping && now() - lease < 700,
        onSent(value) { send({ op: 'sent', event: value.type, point: { x: value.x, y: value.y } }); }
    }));
    function finish(reason) {
        if (stopping) return;
        stopping = true; clear(watch);
        // Only our worker exits. The core retains up until its bounded close.
        ending = later(() => proc.exit(2), 400);
        input.close().then(() => {
            const exit = () => { clear(ending); proc.exit(reason ? 1 : 0); };
            if (!proc.connected) return exit();
            clear(ending); ending = later(exit, 50);
            try { proc.send({ op: 'closed', reason: reason || null }, exit); } catch (_) { exit(); }
        }, () => proc.exit(2));
    }
    function tick() {
        if (stopping) return;
        if (now() - Math.max(started, lease) >= 700) return finish('lease-expired');
        if (sequence && !input.ready()) return finish('transport');
        watch = later(tick, 50);
    }
    function message(value) {
        if (stopping || !value || typeof value !== 'object') return;
        if (value.op === 'stop') return finish();
        if (value.op === 'lease') {
            if (!Number.isSafeInteger(value.seq) || value.seq <= sequence || typeof value.focus !== 'boolean') return;
            if (now() - Math.max(started, lease) >= 700) return finish('lease-expired');
            sequence = value.seq; lease = now();
            input.enable(true); input.setVisible(true); input.setFocus(value.focus);
            send({ op: 'ready', seq: sequence, ready: input.ready() });
        } else if (value.op === 'cancel') input.cancel();
        else if (value.op === 'touch') {
            if (!Number.isSafeInteger(value.id) || value.id <= command) return;
            command = value.id;
            const accepted = input.touch(value.phase, value.point);
            send({ op: 'ack', id: command, accepted });
        }
    }
    proc.on('message', message);
    proc.on('disconnect', () => finish('disconnected'));
    proc.on('SIGTERM', () => finish('terminated'));
    proc.on('SIGINT', () => finish('terminated'));
    proc.on('uncaughtException', () => finish('exception'));
    watch = later(tick, 50);
    return { finish };
}

// Recovery is a release only, after the parent has observed its own worker's
// death. It never creates a down or selects another display/source.
function releaseOnce(options) {
    options = options || {};
    const proc = options.process || process;
    const later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
    let socket, sent = false, ended = false;
    const timer = later(() => finish(false), 300);
    function finish(ok) {
        if (ended) return;
        ended = true; clear(timer);
        if (socket) { try { socket.close(); } catch (_) {} }
        proc.exit(ok ? 0 : 2);
    }
    proc.on('message', message => {
        if (sent || ended || !message || message.op !== 'release' || !message.point) return;
        let bytes;
        try { bytes = touchPdu(3, message.point.x, message.point.y); } catch (_) { return finish(false); }
        sent = true;
        try {
            socket = (options.createSocket || (() => require('dgram').createSocket('udp4')))();
            socket.on('error', () => finish(false));
            socket.send(bytes, 30567, '127.0.0.1', error => {
                if (error || !proc.connected) return finish(!error);
                try { proc.send({ op: 'released' }, () => finish(true)); } catch (_) { finish(true); }
            });
        } catch (_) { finish(false); }
    });
    proc.on('disconnect', () => { if (!sent) finish(false); });
    proc.on('SIGTERM', () => finish(false));
    proc.on('uncaughtException', () => finish(false));
}

if (require.main === module) {
    if (!process.send) process.exit(2);
    else if (process.argv[2] === '--release') releaseOnce();
    else run();
}
module.exports = { run, releaseOnce };
