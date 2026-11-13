'use strict';

// Audio failure never pauses FFmpeg's PCM pipe or restarts its video decoder.
function playAudio(pcm, changed, queue, audio, spawn, log) {
    let sink, ready = false, blocked = false, stopped = false;
    let timer, stalled, retry;
    let failures = 0;
    let tail = Buffer.alloc(0);
    const retryMs = audio.retryMs || 2000;
    const maxRetries = audio.maxRetries === undefined ? 3 : audio.maxRetries;

    function release() {
        clearTimeout(timer);
        clearTimeout(stalled);
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
        release();
        log.warn('TDTWorld: salida de audio: ' + reason + (detail ? ' (' + detail + ')' : ''));
        changed('audio-' + reason, detail);
        if (failures++ < maxRetries) retry = setTimeout(() => { retry = null; open(); }, retryMs * failures);
    }
    function open() {
        if (stopped || sink) return;
        let peer;
        try { peer = spawn(audio.command, audio.args, { stdio: ['pipe', audio.handshake ? 'pipe' : 'ignore', 'pipe'] }); }
        catch (_) { changed('audio-unavailable'); return; }
        sink = peer;
        changed('audio-connecting');
        let diagnostic = '', stderr = '', reply = '';
        const failure = (reason) => fail(peer, reason, diagnostic);
        peer.on('error', () => failure('unavailable'));
        peer.on('close', (code) => failure({ 3: 'alsa', 4: 'open', 5: 'format', 7: 'write', 8: 'stall' }[code] || 'unavailable'));
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
        if (stopped || !ready || blocked) return;
        const peer = sink;
        if (!peer.stdin.write(bytes)) {
            blocked = true;
            stalled = setTimeout(() => fail(peer, 'pipe'), 2500);
        }
    }
    pcm.on('data', (bytes) => {
        if (stopped) return;
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
        close() { stopped = true; clearTimeout(retry); release(); }
    };
}

module.exports = playAudio;
