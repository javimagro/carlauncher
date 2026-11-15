'use strict';
const { StringDecoder } = require('string_decoder');

function consume(receive) {
    let partial = '';
    const decoder = new StringDecoder('utf8');
    return (chunk) => {
        if (chunk.length > 8192) return false;
        partial += decoder.write(chunk);
        if (Buffer.byteLength(partial) > 8192) return false;
        let at;
        while ((at = partial.indexOf('\n')) >= 0) {
            const line = partial.slice(0, at); partial = partial.slice(at + 1);
            let message;
            try { message = JSON.parse(line); } catch (_) { return false; }
            receive(message);
        }
        return true;
    };
}

function createBridge(send) {
    let available = false, job;
    function stop(id) {
        if (!job || (id && job.id !== id)) return;
        const old = job; job = null;
        clearInterval(old.timer);
        send(JSON.stringify({ id: old.id, op: 'stop' }) + '\n');
    }
    return {
        start(id, path, changed) {
            stop();
            if (!available || !/^[a-f0-9]{16}$/.test(id) || path !== '/dev/shm/bmw-tdt-native-' + id + '/audio.wav') {
                changed({ id, state: 'error', code: 'bridge' }); return;
            }
            const current = job = { id, changed };
            if (!send(JSON.stringify({ op: 'play', id, path }) + '\n')) {
                stop(); changed({ id, state: 'error', code: 'bridge' }); return;
            }
            current.timer = setInterval(() => {
                if (job === current && !send(JSON.stringify({ op: 'keepalive', id }) + '\n')) {
                    stop(); changed({ id, state: 'error', code: 'bridge' });
                }
            }, 1000);
        },
        receive(message) {
            if (!message || typeof message !== 'object') return;
            if (message.state === 'ready' && !message.id) { available = true; return; }
            if (!job || message.id !== job.id || !['waiting', 'playing', 'paused', 'ended', 'error'].includes(message.state)) return;
            const value = { id: message.id, state: message.state };
            if (['playing', 'paused'].includes(value.state)) {
                if (!Number.isFinite(message.elapsed) || message.elapsed < 0 || message.elapsed > 32000 ||
                    !Number.isFinite(message.total) || message.total < 1000 || message.total > 32000) return;
                value.elapsed = message.elapsed; value.total = message.total;
            }
            if (['route', 'busy', 'connect', 'play', 'connections', 'clock', 'read', 'service'].includes(message.code)) value.code = message.code;
            if (typeof message.result === 'string' && /^[A-Z0-9_]{1,40}$/.test(message.result)) value.result = message.result;
            job.changed(value);
        },
        disconnected() {
            available = false;
            if (job) { const old = job; stop(); old.changed({ id: old.id, state: 'error', code: 'bridge' }); }
        },
        stop
    };
}
module.exports = { createBridge, consume };
