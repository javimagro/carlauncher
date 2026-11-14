'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const playAudio = require('./tdt-audio.js');
const { selectDash } = require('./tdt-dash');
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

function decoderFailureKind(stderr) {
    if (/Stream map[^\n]*a:0[^\n]*matches no streams/i.test(stderr)) return 'audio-missing';
    if (/Stream map[^\n]*matches no streams/i.test(stderr)) return 'stream-map';
    if (/(?:HTTP error |Server returned )(?:429|5\d{2})|timed out|Connection (?:reset|refused)|End of file/i.test(stderr)) return 'network';
    return 'decoder';
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
    const cursor = Buffer.alloc(4);
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
            cursor.writeUInt32LE(slot, 0);
            write(fd, cursor, 20);
            cursor.writeUInt32LE(seq, 0);
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
    bufferSeconds = preview ? 0 : 2, pacedInput = preview, get, log = console, spawnProcess = spawn, onStats = () => {} } = {}) {
    const w = preview ? 320 : 640;
    const h = preview ? 180 : 360;
    const fps = preview ? 8 : 20;
    const size = preview ? w * h * 4 : w * h * 3 / 2;
    const prebuffer = Math.ceil(fps * bufferSeconds);
    const maxFrames = 2 * prebuffer;
    const pcmSize = 48000 * 4 / fps;
    const epoch = process.hrtime();
    const clock = () => { const t = process.hrtime(epoch); return t[0] * 1000 + t[1] / 1e6; };
    let capable = preview;
    let job;
    let surface;

    function clearDecoder(current) {
        clearTimeout(current.timer);
        clearTimeout(current.playout);
        clearInterval(current.statsTimer);
        const video = current.video;
        current.video = null;
        if (current.closeAudio) { current.closeAudio(); current.closeAudio = null; }
        if (video) {
            video.kill();
            // A paused pipe must still close after cancellation; its callbacks
            // already reject this generation before copying any bytes.
            if (video.stdout) video.stdout.resume();
            const force = setTimeout(() => { if (video.exitCode === null) video.kill('SIGKILL'); }, 500);
            force.unref();
        }
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
        const relayed = network && network.dashUrl && source.startsWith(network.dashUrl);
        const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000',
            '-reconnect', '1', '-reconnect_on_network_error', '1', '-reconnect_streamed', '1',
            '-reconnect_on_http_error', '429,5xx', '-reconnect_max_retries', '2', '-reconnect_delay_max', '2'];
        if (network && !relayed) args.push('-http_proxy', network.url);
        if (caFile && !relayed) args.push('-tls_verify', '1');
        // For adapted DASH, HTTPS and certificate verification belong to the
        // network relay. FFmpeg only sees capability-protected loopback HTTP.
        args.push('-protocol_whitelist', relayed ? 'http,tcp' : 'http,https,tcp,tls,httpproxy,crypto');
        if (pacedInput) args.push('-re');
        if (prebuffer && pacedInput) args.push('-readrate_initial_burst', String(bufferSeconds + 0.5), '-readrate_catchup', '1.5');
        args.push('-i', source);
        return args;
    }

    function decodeProcess(args, network, withAudio) {
        const options = { stdio: withAudio ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] };
        options.env = Object.assign({}, process.env, { no_proxy: '127.0.0.1' });
        if (caFile) options.env.SSL_CERT_FILE = caFile;
        if (network && network.uid) { options.uid = network.uid; options.gid = network.uid; }
        return spawnProcess(ffmpeg, args, options);
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
            output = playAudio(video.stdio[3], changed, queue, audio, spawnProcess, log);
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
        let pendingBytes;
        let deadline = 0, previousFrame = 0;
        const stats = current.stats;
        let lastDecoded = 0;
        stats.attempts++;
        stats.audioEnabled = !!withAudio;
        current.statsTimer = setInterval(() => onStats(Object.assign({}, stats, { queued: frames.length, fps, audio: output ? output.stats() : null })), 5000);
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
            const at = clock();
            if (previousFrame) stats.maxGapMs = Math.max(stats.maxGapMs, Math.round(at - previousFrame));
            previousFrame = at;
            stats.presented++;
            if (!playing) {
                playing = true;
                changed('playing');
            } else if (preview) changed('frame');
        }
        if (prebuffer) {
            const tick = () => {
                if (job !== current || current.video !== video) return;
                try {
                    if (decoderEnded && !frames.length) { failed(video, 'error', ready, decoderEnded.reason, decoderEnded.kind); return; }
                    if (!frames.length) {
                        if (playing) { playing = false; stats.underruns++; changed('buffering'); }
                        deadline = 0;
                        return;
                    }
                    if (!playing && !decoderEnded && frames.length < prebuffer) return;
                    const at = clock();
                    if (!deadline) deadline = at;
                    if (at < deadline) return;
                    const due = Math.floor((at - deadline) * fps / 1000) + 1;
                    // Recover the media clock after scheduler jitter; never slow PCM
                    // permanently by treating a late callback as just one 50-ms tick.
                    for (let skip = Math.min(due - 1, frames.length - 1); skip > 0; skip--) {
                        spareFrames.push(frames.shift());
                        if (queue) queue.take(pcmSize);
                        stats.dropped++;
                    }
                    deadline += due * 1000 / fps;
                    const next = frames.shift();
                    present(next);
                    spareFrames.push(next);
                    if (queue && job === current && current.video === video) {
                        // The pending write owns its buffer until the stream consumes it.
                        if (queue.take(pcmSize, pcm)) output.write(Buffer.from(pcm));
                    }
                    if (video.stdout.isPaused() && frames.length <= prebuffer) {
                        const pending = pendingBytes;
                        pendingBytes = undefined;
                        if (pending) receiveVideo(pending);
                        if (job === current && current.video === video && frames.length < maxFrames) video.stdout.resume();
                    }
                } finally {
                    if (job === current && current.video === video) {
                        current.playout = setTimeout(tick, Math.max(1, deadline ? deadline - clock() : 1000 / fps));
                    }
                }
            };
            current.playout = setTimeout(tick, 1000 / fps);
        }
        function timedOut() { failed(video, 'error', ready, videoFailure(diagnostic, 'sin fotogramas'), 'timeout'); }
        current.timer = setTimeout(timedOut, 16000);
        function receiveVideo(bytes) {
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
                stats.decoded++;
                const decodedAt = clock();
                if (lastDecoded) stats.maxDecodeGapMs = Math.max(stats.maxDecodeGapMs, Math.round(decodedAt - lastDecoded));
                lastDecoded = decodedAt;
                diagnostic = '';
                if (prebuffer) {
                    frames.push(frame);
                    frame = spareFrames.pop() || Buffer.allocUnsafe(size);
                } else present(frame);
                if (job !== current || current.video !== video) return;
                clearTimeout(current.timer);
                current.timer = setTimeout(timedOut, 12000);
                if (prebuffer && frames.length >= maxFrames) {
                    // HLS can decode a whole segment in a burst. Preserve those
                    // frames in the producer instead of deleting future playout.
                    // Audio remains drained by its independent listener.
                    video.stdout.pause();
                    if (position < bytes.length) pendingBytes = bytes.slice(position);
                    break;
                }
            }
        }
        video.stdout.on('data', receiveVideo);
        video.on('error', (error) => failed(video, error.code === 'ENOENT' ? 'unavailable' : 'error', ready));
        video.on('close', (code) => {
            if (job !== current || current.video !== video) return;
            const reason = videoFailure(diagnostic, code ? 'decodificador ' + code : 'fin de emisión');
            if (prebuffer && frames.length) {
                clearTimeout(current.timer);
                decoderEnded = { reason, kind: decoderFailureKind(diagnostic) };
            } else failed(video, 'error', ready, reason, decoderFailureKind(diagnostic));
        });
    }

    return {
        ready(info) { capable = preview || !!(info && info.video && gpu.video); },
        frame: () => surface,
        stop,
        start(sources, changed) {
            stop();
            if (!capable) { changed('unavailable'); return; }
            const current = { stats: { decoded: 0, presented: 0, underruns: 0, dropped: 0, maxGapMs: 0,
                maxDecodeGapMs: 0, attempts: 0, reconnects: 0, audioEnabled: false, dashAdapted: false } };
            job = current;
            let index = 0;
            async function nextSource() {
                let source = sources[index++];
                current.stats.dashAdapted = false;
                let program;
                if (get && /\.m3u8(?:[?#]|$)/i.test(source)) {
                    try { program = hlsProgram(await get(source, 256 * 1024, 4000), w, h); }
                    catch (_) { /* Let FFmpeg open the original source. */ }
                }
                if (get && current.network && current.network.dashUrl && /\.mpd(?:[?#]|$)/i.test(source)) {
                    try {
                        const bytes = await get(source, 256 * 1024, 4000);
                        if (job !== current) return;
                        // Unsupported layouts retain their original path. A supported
                        // manifest is refreshed and filtered by the network process.
                        selectDash(bytes, source, (url) => url, w, h);
                        source = current.network.dashUrl + encodeURIComponent(source);
                        current.stats.dashAdapted = true;
                    } catch (_) { /* Preserve compatibility with other DASH profiles. */ }
                }
                try { attempt(source, program, !!audio); }
                catch (_) { if (job === current) { stop(); changed('error'); } }
            }
            function attempt(source, program, withAudio, retry = true) {
                if (job !== current) return;
                const started = Date.now();
                const fail = (video, status, decoded, detail, kind) => {
                    if (current !== job || current.video !== video) return;
                    clearDecoder(current);
                    if (detail) log.warn('TDTWorld: vídeo: ' + detail);
                    if (status === 'error' && program !== undefined && !decoded && (kind === 'stream-map' || kind === 'audio-missing')) attempt(source, undefined, withAudio, retry);
                    else if (status === 'error' && withAudio && !decoded && kind === 'audio-missing') attempt(source, program, false, retry);
                    else if (status === 'error' && (decoded || kind === 'network' || kind === 'timeout') && (retry || Date.now() - started >= 60000)) {
                        current.stats.reconnects++;
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
