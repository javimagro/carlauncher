'use strict';
const { createFocus } = require('./tdt-audio-focus');

// Audio failure never pauses FFmpeg's PCM pipe or restarts its video decoder.
function playAudio(pcm, changed, queue, audio, spawn, log) {
    const stats = { receivedBytes: 0, submittedBytes: 0, droppedBytes: 0,
        notReadyBytes: 0, blockedBytes: 0, backpressure: 0, failures: 0 };
    let sink, ready = false, blocked = false, stopped = false;
    let timer, stalled, retry, draining;
    let failures = 0;
    let tail = Buffer.alloc(0);
    const retryMs = audio.retryMs || 2000;
    const maxRetries = audio.maxRetries === undefined ? 3 : audio.maxRetries;
    let focus, focusReady = !audio.bmwFocus, focusPending = false, focusFailed = false;

    function release() {
        clearTimeout(timer);
        clearTimeout(stalled);
        draining = undefined;
        timer = stalled = undefined;
        const old = sink;
        sink = null;
        ready = blocked = false;
        if (old) {
            old.kill();
            const force = setTimeout(() => { if (old.exitCode === null) old.kill('SIGKILL'); }, 500);
            force.unref();
        }
    }
    function fail(peer, reason, detail) {
        if (stopped || sink !== peer) return;
        stats.failures++;
        release();
        log.warn('TDTWorld: salida de audio: ' + reason + (detail ? ' (' + detail + ')' : ''));
        changed('audio-' + reason, detail);
        if (failures++ < maxRetries && !stopped) retry = setTimeout(() => { retry = null; open(); }, retryMs * failures);
        else if (focus) { focusFailed = true; focusReady = false; focus.close(); }
    }
    function open() {
        if (stopped || sink) return;
        if (!focusReady) {
            if (focusPending || focusFailed) return;
            focusPending = true;
            changed('audio-focus-wait');
            const lost = (reason) => {
                if (stopped) return;
                focusFailed = true; focusReady = false;
                clearTimeout(retry); retry = null; release();
                if (focus) focus.close();
                changed(reason === 'lost' ? 'audio-focus-lost' : 'audio-focus-error');
            };
            focus = (audio.createFocus || createFocus)(lost);
            focus.start().then(() => {
                focusPending = false;
                if (stopped) { focus.close(); return; }
                focusReady = true; open();
            }, () => { focusPending = false; lost('error'); });
            return;
        }
        let peer;
        try { peer = spawn(audio.command, audio.args, { stdio: ['pipe', audio.handshake ? 'pipe' : 'ignore', 'pipe'] }); }
        catch (_) { fail(sink, 'unavailable'); return; }
        sink = peer;
        changed('audio-connecting');
        let diagnostic = '', stderr = '', reply = '';
        const failure = (reason) => fail(peer, reason, diagnostic);
        peer.on('error', () => failure('unavailable'));
        peer.on('close', (code) => {
            if (sink === peer && draining && code === 0) {
                const done = draining;
                sink = null;
                release();
                done();
            } else failure({ 3: 'alsa', 4: 'open', 5: 'format', 7: 'write', 8: 'stall' }[code] || 'unavailable');
        });
        peer.stderr.on('data', (chunk) => {
            stderr = (stderr + String(chunk)).slice(-512);
            const found = /(?:^|\n)tdt-pcm: ((?:open|format|write|recover|stall|state|nonblock)=-?\d{1,6})\r?\n/g;
            let match;
            while ((match = found.exec(stderr))) diagnostic = match[1];
        });
        peer.stdin.on('error', () => {
            if (sink !== peer) return;
            blocked = true;
            if (!stalled) stalled = setTimeout(() => failure('pipe'), 2500);
        });
        peer.stdin.on('drain', () => {
            if (sink !== peer) return;
            blocked = false;
            clearTimeout(stalled);
            stalled = undefined;
        });
        if (!audio.handshake) { ready = true; changed('audio-ready'); return; }
        peer.stdout.on('data', (chunk) => {
            if (sink !== peer || ready) return;
            reply = (reply + String(chunk)).slice(0, 32);
            if (!reply.startsWith('ready\n')) return;
            clearTimeout(timer);
            ready = true;
            changed('audio-ready');
        });
        timer = setTimeout(() => failure('timeout'), 4000);
    }
    function write(bytes) {
        if (stopped || !ready || blocked) {
            stats.droppedBytes += bytes.length;
            if (blocked && ready && !stopped) stats.blockedBytes += bytes.length;
            else stats.notReadyBytes += bytes.length;
            return;
        }
        const peer = sink;
        stats.submittedBytes += bytes.length; // Pipe accepted bytes, NOT proof of ALSA playback.
        if (!peer.stdin.write(bytes)) {
            stats.backpressure++;
            blocked = true;
            stalled = setTimeout(() => fail(peer, 'pipe'), 2500);
        }
    }
    pcm.on('data', (bytes) => {
        if (stopped) return;
        stats.receivedBytes += bytes.length;
        if (queue) queue.push(bytes);
        if (!sink && !retry && failures === 0) open();
        if (queue) return;
        const buffer = tail.length ? Buffer.concat([tail, bytes]) : bytes;
        const length = buffer.length - buffer.length % 4;
        tail = Buffer.from(buffer.slice(length));
        if (length) write(buffer.slice(0, length));
    });
    pcm.on('error', () => { if (sink) fail(sink, 'unavailable'); });
    return {
        write,
        drain(done) {
            if (!sink || !ready) { done(); return; }
            const peer = sink;
            draining = done;
            timer = setTimeout(() => fail(peer, 'stall'), 4000);
            peer.stdin.end();
        },
        stats: () => Object.assign({}, stats, { ready, blocked }),
        close() { stopped = true; clearTimeout(retry); release(); if (focus) focus.close(); }
    };
}

module.exports = playAudio;
