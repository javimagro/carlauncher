'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const { makeImage, dropImage } = require('./vendor/kit_record.js');

const videoId = 1;
const slots = 3;
const headerSize = 64;

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

function createPlayer(gpu, { ffmpeg = 'ffmpeg', caFile, proxy, audio, directory = '/dev/shm', preview = false,
    log = console, spawnProcess = spawn } = {}) {
    const w = preview ? 320 : 640;
    const h = preview ? 180 : 360;
    const fps = preview ? 8 : 20;
    const size = preview ? w * h * 4 : w * h * 3 / 2;
    let capable = preview;
    let job;
    let surface;

    function clearDecoder(current) {
        clearTimeout(current.timer);
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
        args.push('-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto', '-re', '-i', source);
        return args;
    }

    function decodeProcess(args, network, withAudio) {
        const options = { stdio: withAudio ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] };
        if (caFile) options.env = Object.assign({}, process.env, { SSL_CERT_FILE: caFile });
        if (network && network.uid) { options.uid = network.uid; options.gid = network.uid; }
        return spawnProcess(ffmpeg, args, options);
    }

    function playAudio(pcm, changed) {
        let sink;
        let ended = false;
        let ready = false;
        let blocked = false;
        let timer;
        let stalled;
        let tail = Buffer.alloc(0);
        function close(reason) {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            clearTimeout(stalled);
            if (sink) sink.kill();
            if (reason) {
                log.warn('TDTWorld: salida de audio: ' + reason);
                changed('audio-' + reason);
            }
        }
        function open() {
            try {
                sink = spawnProcess(audio.command, audio.args, { stdio: ['pipe', audio.handshake ? 'pipe' : 'ignore', 'ignore'] });
            } catch (_) { close('unavailable'); return; }
            sink.on('error', () => close('unavailable'));
            sink.on('close', (code) => close({ 3: 'alsa', 4: 'open', 5: 'format', 7: 'write' }[code] || 'unavailable'));
            // The close event supplies the helper's exit code after an EPIPE.
            sink.stdin.on('error', () => {
                blocked = true;
                if (!stalled) stalled = setTimeout(() => close('write'), 2500);
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
        // Consume the decoder's PCM even when ALSA stalls. Discard whole stereo frames only.
        pcm.on('data', (bytes) => {
            if (ended) return;
            if (!sink) open();
            const buffer = tail.length ? Buffer.concat([tail, bytes]) : bytes;
            const length = buffer.length - buffer.length % 4;
            tail = Buffer.from(buffer.slice(length));
            if (!length || !ready || blocked || ended) return;
            if (!sink.stdin.write(buffer.slice(0, length))) {
                blocked = true;
                stalled = setTimeout(() => close('write'), 2500);
            }
        });
        pcm.on('error', () => close('unavailable'));
        return close;
    }

    function decode(current, source, withAudio, failed, changed) {
        const scale = 'fps=' + fps + ',scale=' + w + ':' + h
            + ':force_original_aspect_ratio=decrease:out_color_matrix=bt709,pad=' + w + ':' + h + ':(ow-iw)/2:(oh-ih)/2';
        const args = input(source, current.network).concat([
            '-map', '0:v:0', '-an', '-vf', scale, '-pix_fmt', preview ? 'rgba' : 'yuv420p', '-f', 'rawvideo', 'pipe:1'
        ]);
        if (withAudio) args.push('-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:3');
        const video = decodeProcess(args, current.network, withAudio);
        current.video = video;
        if (withAudio) {
            changed('audio-connecting');
            current.closeAudio = playAudio(video.stdio[3], changed);
        }
        else if (audio) changed('audio-unavailable');
        let diagnostic = '';
        video.stderr.on('data', (chunk) => {
            if (diagnostic.length < 400) diagnostic += String(chunk).slice(0, 400 - diagnostic.length);
        });
        let offset = 0;
        let ready = false;
        const frame = Buffer.allocUnsafe(size);
        current.timer = setTimeout(() => failed(video, 'error', ready), 16000);
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
                try {
                    if (preview) {
                        if (surface) dropImage(surface.image);
                        surface = { image: makeImage(w, h, Buffer.from(frame)) };
                    } else {
                        if (!current.ring) {
                            current.ring = createRing(directory, w, h);
                            gpu.video(videoId, current.ring.file);
                        }
                        current.ring.push(frame);
                        surface = { id: videoId };
                    }
                } catch (_) { failed(video, 'unavailable'); return; }
                if (!ready) {
                    ready = true;
                    changed('playing');
                } else if (preview) changed('frame');
                if (job !== current || current.video !== video) return;
                clearTimeout(current.timer);
                current.timer = setTimeout(() => failed(video, 'error', ready), 12000);
            }
        });
        video.on('error', (error) => failed(video, error.code === 'ENOENT' ? 'unavailable' : 'error', ready));
        video.on('close', (code) => {
            if (job === current && current.video === video && code) {
                const http = /(?:HTTP error |Server returned )(\d{3})/.exec(diagnostic);
                log.warn('TDTWorld: FFmpeg terminó con código ' + code + (http ? ' (HTTP ' + http[1] + ')' : ''));
            }
            failed(video, 'error', ready);
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
            function attempt(source, withAudio, retry = true) {
                if (job !== current) return;
                const started = Date.now();
                const fail = (video, status, decoded) => {
                    if (current !== job || current.video !== video) return;
                    clearDecoder(current);
                    if (status === 'error' && withAudio && !decoded) attempt(source, false, retry);
                    else if (status === 'error' && decoded && (retry || Date.now() - started >= 60000)) {
                        changed('reconnecting');
                        current.retryTimer = setTimeout(() => attempt(source, withAudio, false), 1000);
                    } else if (status === 'error' && index < sources.length) {
                        changed(surface ? 'reconnecting' : 'loading');
                        attempt(sources[index++], !!audio);
                    }
                    else { stop(); changed(status); }
                };
                decode(current, source, withAudio, fail, changed);
            }
            Promise.resolve().then(() => proxy && proxy()).then((network) => {
                if (job !== current) { if (network) network.close(); return; }
                current.network = network;
                attempt(sources[index++], !!audio);
            }).catch(() => {
                if (job === current) { stop(); changed('error'); }
            });
        }
    };
}

module.exports = { createPlayer, createRing };
