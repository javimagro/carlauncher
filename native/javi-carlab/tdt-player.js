'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const { makeImage, dropImage } = require('./vendor/kit_record.js');

const videoId = 1;
const slots = 3;
const headerSize = 64;

function hlsProgram(bytes, width, height) {
    const variants = String(bytes).split(/\r?\n/).filter((line) => line.startsWith('#EXT-X-STREAM-INF:'));
    let choice;
    variants.forEach((line, index) => {
        const match = /(?:^|[:,])RESOLUTION=(\d{1,5})x(\d{1,5})(?:,|$)/.exec(line);
        if (!match) return;
        const w = Number(match[1]), h = Number(match[2]);
        if (!w || !h) return;
        const fits = w <= width && h <= height;
        const pixels = w * h;
        if (!choice || (fits && !choice.fits) ||
            (fits === choice.fits && (fits ? pixels > choice.pixels : pixels < choice.pixels))) {
            choice = { index, fits, pixels };
        }
    });
    return choice && choice.index;
}

function videoFailure(stderr, fallback) {
    const http = /(?:HTTP error |Server returned )([45]\d{2})/.exec(stderr);
    if (http) return 'HTTP ' + http[1];
    if (/timed out/i.test(stderr)) return 'tiempo agotado';
    return fallback;
}

function write(fd, bytes, offset) {
    for (let at = 0; at < bytes.length;) {
        const n = fs.writeSync(fd, bytes, at, bytes.length - at, offset + at);
        if (!n) throw new Error('Escritura de vídeo incompleta');
        at += n;
    }
}

function createRing(directory, w, h) {
    const file = directory + '/mgu-video-bmwlauncher-' + crypto.randomBytes(8).toString('hex');
    const fd = fs.openSync(file, 'wx', 0o600);
    const size = w * h * 3 / 2;
    const header = Buffer.alloc(headerSize);
    [0x4656474d, 1, w, h, 0, 0, slots, 1, 0].forEach((value, i) => header.writeUInt32LE(value, i * 4));
    const cursor = Buffer.alloc(8);
    let seq = 0;
    let slot = 0;
    function close() {
        try { fs.closeSync(fd); } finally { fs.unlinkSync(file); }
    }
    try {
        fs.ftruncateSync(fd, headerSize + slots * size);
        write(fd, header, 0);
    } catch (error) { close(); throw error; }
    return {
        file, close,
        push(frame) {
            slot = (slot + 1) % slots;
            write(fd, frame, headerSize + slot * size);
            seq = (seq + 1) >>> 0;
            cursor.writeUInt32LE(seq, 0);
            cursor.writeUInt32LE(slot, 4);
            write(fd, cursor, 16);
        }
    };
}

function createPcmQueue(limit) {
    const chunks = [];
    let queued = 0;
    let offset = 0;

    function take(length, target) {
        if (queued < length) return false;
        for (let at = 0; at < length;) {
            const chunk = chunks[0];
            const count = Math.min(length - at, chunk.length - offset);
            if (target) chunk.copy(target, at, offset, offset + count);
            at += count;
            offset += count;
            if (offset === chunk.length) { chunks.shift(); offset = 0; }
        }
        queued -= length;
        return true;
    }

    return {
        push(chunk) {
            chunks.push(chunk);
            queued += chunk.length;
            if (queued > limit) take(Math.ceil((queued - limit) / 4) * 4);
        },
        take
    };
}

function createPlayer(gpu, { ffmpeg = 'ffmpeg', caFile, proxy, audio, directory = '/dev/shm', preview = false,
    bufferSeconds = preview ? 0 : 2, get, log = console, spawnProcess = spawn } = {}) {
    const w = preview ? 320 : 640;
    const h = preview ? 180 : 360;
    const fps = preview ? 8 : 20;
    const size = preview ? w * h * 4 : w * h * 3 / 2;
    const prebuffer = Math.ceil(fps * bufferSeconds);
    const maxFrames = 2 * prebuffer;
    const pcmSize = 48000 * 4 / fps;
    let capable = preview;
    let job;
    let surface;

    function clearDecoder(current) {
        clearTimeout(current.timer);
        clearInterval(current.playout);
        const video = current.video;
        current.video = null;
        if (current.closeAudio) { current.closeAudio(); current.closeAudio = null; }
        if (video) video.kill();
    }

    function stop() {
        if (!job) return;
        const current = job;
        job = undefined;
        clearTimeout(current.retryTimer);
        clearDecoder(current);
        if (current.ring) {
            gpu.video(videoId, null);
            try { current.ring.close(); }
            catch (error) { log.warn('TDTWorld: búfer de vídeo: ' + error.code); }
        }
        if (surface && surface.image) dropImage(surface.image);
        surface = undefined;
        if (current.network) current.network.close();
    }

    function input(source, network) {
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000',
            '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_streamed', '1',
            '-reconnect_on_http_error', '429,5xx', '-reconnect_max_retries', '2', '-reconnect_delay_max', '2'];
        if (network) args.push('-http_proxy', network.url);
        if (caFile) args.push('-tls_verify', '1');
        args.push('-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto', '-re');
        if (prebuffer) args.push('-readrate_initial_burst', String(bufferSeconds + 0.5), '-readrate_catchup', '1.5');
        args.push('-i', source);
        return args;
    }

    function decodeProcess(args, network, withAudio) {
        const options = { stdio: withAudio ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] };
        if (caFile) options.env = Object.assign({}, process.env, { SSL_CERT_FILE: caFile });
        if (network && network.uid) { options.uid = network.uid; options.gid = network.uid; }
        return spawnProcess(ffmpeg, args, options);
    }

    function playAudio(pcm, changed, queue) {
        let sink;
        let ended = false;
        let ready = false;
        let blocked = false;
        let timer;
        let stalled;
        let diagnostic = '';
        let tail = Buffer.alloc(0);
        function close(reason) {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            clearTimeout(stalled);
            if (sink) sink.kill();
            if (reason) {
                log.warn('TDTWorld: salida de audio: ' + reason + (diagnostic ? ' (' + diagnostic + ')' : ''));
                changed('audio-' + reason, diagnostic);
            }
        }
        function open() {
            try {
                sink = spawnProcess(audio.command, audio.args, { stdio: ['pipe', audio.handshake ? 'pipe' : 'ignore', 'pipe'] });
            } catch (_) { close('unavailable'); return; }
            sink.on('error', () => close('unavailable'));
            sink.on('close', (code) => close({ 3: 'alsa', 4: 'open', 5: 'format', 7: 'write', 8: 'stall' }[code] || 'unavailable'));
            let stderr = '';
            sink.stderr.on('data', (chunk) => {
                stderr = (stderr + String(chunk)).slice(-512);
                const result = /(?:^|\n)tdt-pcm: ((?:open|format|write|recover|stall)=-?\d{1,4})\r?\n/.exec(stderr);
                if (result) diagnostic = result[1];
            });
            // The close event supplies the helper's exit code after an EPIPE.
            sink.stdin.on('error', () => {
                blocked = true;
                if (!stalled) stalled = setTimeout(() => close('pipe'), 2500);
            });
            sink.stdin.on('drain', () => { blocked = false; clearTimeout(stalled); stalled = undefined; });
            if (!audio.handshake) { ready = true; changed('audio-ready'); return; }
            let reply = '';
            sink.stdout.on('data', (chunk) => {
                if (ended || ready || reply.length >= 6) return;
                reply += String(chunk).slice(0, 6);
                if (!reply.startsWith('ready\n')) return;
                clearTimeout(timer);
                ready = true;
                changed('audio-ready');
            });
            timer = setTimeout(() => close('timeout'), 4000);
        }
        function writePcm(bytes) {
            if (ended || !ready || blocked) return;
            if (!sink.stdin.write(bytes)) {
                blocked = true;
                stalled = setTimeout(() => close('pipe'), 2500);
            }
        }
        // Drain the decoder even when ALSA stalls. Discard whole stereo frames only.
        pcm.on('data', (bytes) => {
            if (ended && !queue) return;
            if (queue) queue.push(bytes);
            if (ended) return;
            if (!sink) open();
            if (queue) return;
            const buffer = tail.length ? Buffer.concat([tail, bytes]) : bytes;
            const length = buffer.length - buffer.length % 4;
            tail = Buffer.from(buffer.slice(length));
            if (length) writePcm(buffer.slice(0, length));
        });
        pcm.on('error', () => close('unavailable'));
        return { close, write: writePcm };
    }

    function decode(current, source, program, withAudio, failed, changed) {
        const scale = 'fps=' + fps + ',scale=' + w + ':' + h
            + ':force_original_aspect_ratio=decrease:out_color_matrix=bt709,pad=' + w + ':' + h + ':(ow-iw)/2:(oh-ih)/2';
        const selector = program === undefined ? '0:' : '0:p:' + program + ':';
        const args = input(source, current.network).concat([
            '-map', selector + 'v:0', '-an', '-vf', scale, '-pix_fmt', preview ? 'rgba' : 'yuv420p', '-f', 'rawvideo', 'pipe:1'
        ]);
        if (withAudio) args.push('-map', selector + 'a:0', '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:3');
        const video = decodeProcess(args, current.network, withAudio);
        current.video = video;
        const frames = [];
        const spareFrames = [];
        const queue = withAudio && prebuffer ? createPcmQueue((maxFrames + fps) * pcmSize) : null;
        const pcm = queue && Buffer.allocUnsafe(pcmSize);
        let output;
        if (withAudio) {
            changed('audio-connecting');
            output = playAudio(video.stdio[3], changed, queue);
            current.closeAudio = output.close;
        }
        else if (audio) changed('audio-unavailable');
        let diagnostic = '';
        video.stderr.on('data', (chunk) => {
            diagnostic = (diagnostic + String(chunk)).slice(-1000);
        });
        let offset = 0;
        let ready = false;
        let playing = false;
        let decoderEnded;
        let frame = Buffer.allocUnsafe(size);
        function present(bytes) {
            try {
                if (preview) {
                    if (surface) dropImage(surface.image);
                    surface = { image: makeImage(w, h, Buffer.from(bytes)) };
                } else {
                    if (!current.ring) {
                        current.ring = createRing(directory, w, h);
                        gpu.video(videoId, current.ring.file);
                    }
                    current.ring.push(bytes);
                    surface = { id: videoId };
                }
            } catch (_) { failed(video, 'unavailable'); return; }
            if (!playing) {
                playing = true;
                changed('playing');
            } else if (preview) changed('frame');
        }
        if (prebuffer) {
            current.playout = setInterval(() => {
                if (decoderEnded && !frames.length) { failed(video, 'error', ready, decoderEnded); return; }
                if (!frames.length) {
                    if (playing) { playing = false; changed('buffering'); }
                    return;
                }
                if (!playing && !decoderEnded && frames.length < prebuffer) return;
                const next = frames.shift();
                present(next);
                spareFrames.push(next);
                if (queue && job === current && current.video === video) {
                    // The pending write owns its buffer until the stream consumes it.
                    if (queue.take(pcmSize, pcm)) output.write(Buffer.from(pcm));
                }
            }, 1000 / fps);
        }
        function timedOut() { failed(video, 'error', ready, videoFailure(diagnostic, 'sin fotogramas')); }
        current.timer = setTimeout(timedOut, 16000);
        video.stdout.on('data', (bytes) => {
            if (current !== job || current.video !== video) return;
            let position = 0;
            while (position < bytes.length) {
                const count = Math.min(size - offset, bytes.length - position);
                bytes.copy(frame, offset, position, position + count);
                position += count;
                offset += count;
                if (offset !== size) continue;
                offset = 0;
                ready = true;
                diagnostic = '';
                if (prebuffer) {
                    if (frames.length === maxFrames) {
                        spareFrames.push(frames.shift());
                        if (queue) queue.take(pcmSize);
                    }
                    frames.push(frame);
                    frame = spareFrames.pop() || Buffer.allocUnsafe(size);
                } else present(frame);
                if (job !== current || current.video !== video) return;
                clearTimeout(current.timer);
                current.timer = setTimeout(timedOut, 12000);
            }
        });
        video.on('error', (error) => failed(video, error.code === 'ENOENT' ? 'unavailable' : 'error', ready));
        video.on('close', (code) => {
            if (job !== current || current.video !== video) return;
            const reason = videoFailure(diagnostic, code ? 'decodificador ' + code : 'fin de emisión');
            if (prebuffer && frames.length) {
                clearTimeout(current.timer);
                decoderEnded = reason;
            } else failed(video, 'error', ready, reason);
        });
    }

    return {
        ready(info) { capable = preview || !!(info && info.video && gpu.video); },
        frame: () => surface,
        stop,
        start(sources, changed) {
            stop();
            if (!capable) { changed('unavailable'); return; }
            const current = {};
            job = current;
            let index = 0;
            async function nextSource() {
                const source = sources[index++];
                let program;
                if (get && /\.m3u8(?:[?#]|$)/i.test(source)) {
                    try { program = hlsProgram(await get(source, 256 * 1024, 4000), w, h); }
                    catch (_) { /* Let FFmpeg open the original source. */ }
                }
                try { attempt(source, program, !!audio); }
                catch (_) { if (job === current) { stop(); changed('error'); } }
            }
            function attempt(source, program, withAudio, retry = true) {
                if (job !== current) return;
                const started = Date.now();
                const fail = (video, status, decoded, detail) => {
                    if (current !== job || current.video !== video) return;
                    clearDecoder(current);
                    if (detail) log.warn('TDTWorld: vídeo: ' + detail);
                    if (status === 'error' && program !== undefined && !decoded) attempt(source, undefined, withAudio, retry);
                    else if (status === 'error' && withAudio && !decoded) attempt(source, program, false, retry);
                    else if (status === 'error' && decoded && (retry || Date.now() - started >= 60000)) {
                        changed('reconnecting', detail);
                        current.retryTimer = setTimeout(() => attempt(source, program, withAudio, false), 1000);
                    } else if (status === 'error' && index < sources.length) {
                        changed(surface ? 'reconnecting' : 'loading', detail);
                        nextSource();
                    }
                    else { stop(); changed(status, detail); }
                };
                decode(current, source, program, withAudio, fail, changed);
            }
            Promise.resolve().then(() => proxy && proxy()).then((network) => {
                if (job !== current) { if (network) network.close(); return; }
                current.network = network;
                return nextSource();
            }).catch(() => {
                if (job === current) { stop(); changed('error'); }
            });
        }
    };
}

module.exports = { createPlayer, createRing, hlsProgram };
