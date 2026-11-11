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

function createPlayer(gpu, { ffmpeg = 'ffmpeg', caFile, proxy, audio, directory = '/dev/shm', preview = false, log = console } = {}) {
    const w = preview ? 320 : 640;
    const h = preview ? 180 : 360;
    const fps = preview ? 8 : 20;
    const size = preview ? w * h * 4 : w * h * 3 / 2;
    let capable = preview;
    let job;
    let surface;

    function clear(current) {
        clearTimeout(current.timer);
        clearTimeout(current.audioTimer);
        if (current.video) current.video.kill();
        if (current.sink) current.sink.kill();
        if (current.ring) {
            gpu.video(videoId, null);
            try { current.ring.close(); }
            catch (error) { log.warn('TDTWorld: búfer de vídeo: ' + error.code); }
        }
        if (surface && surface.image) dropImage(surface.image);
        surface = undefined;
    }

    function stop() {
        if (!job) return;
        const current = job;
        job = undefined;
        clear(current);
        if (current.network) current.network.close();
    }

    function input(source, network, withAudio) {
        const args = ['-nostdin', '-hide_banner', '-loglevel', withAudio ? 'quiet' : 'error', '-rw_timeout', '8000000'];
        if (network) args.push('-http_proxy', network.url);
        if (caFile) args.push('-tls_verify', '1');
        args.push('-protocol_whitelist', 'http,https,tcp,tls,httpproxy,crypto', '-re', '-i', source);
        return args;
    }

    function decodeProcess(args, network) {
        const options = { stdio: ['ignore', 'pipe', 'pipe'] };
        if (caFile) options.env = Object.assign({}, process.env, { SSL_CERT_FILE: caFile });
        if (network && network.uid) { options.uid = network.uid; options.gid = network.uid; }
        return spawn(ffmpeg, args, options);
    }

    function playAudio(current, pcm, changed) {
        const sink = spawn(audio.command, audio.args, { stdio: ['pipe', audio.handshake ? 'pipe' : 'ignore', 'ignore'] });
        current.sink = sink;
        let ended = false;
        let timer;
        let stalled;
        function drain() {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            clearTimeout(stalled);
            pcm.unpipe(sink.stdin);
            pcm.resume();
            if (job === current && current.sink === sink) changed('audio-unavailable');
        }
        function disableAudio() {
            drain();
            sink.kill();
        }
        sink.on('error', drain);
        sink.on('close', drain);
        sink.stdin.on('error', drain);
        if (!audio.handshake) { pcm.pipe(sink.stdin); return; }
        // Drain PCM until the hardware route is ready so an audio failure cannot stall video.
        pcm.resume();
        let reply = '';
        sink.stdout.on('data', (chunk) => {
            if (ended || reply.length >= 6) return;
            reply += String(chunk);
            if (!reply.startsWith('ready\n')) return;
            clearTimeout(timer);
            pcm.on('pause', () => {
                if (!ended && job === current) stalled = setTimeout(disableAudio, 2000);
            });
            pcm.on('resume', () => clearTimeout(stalled));
            pcm.pipe(sink.stdin);
            if (job === current && current.sink === sink) changed('audio-ready');
        });
        timer = setTimeout(disableAudio, 3500);
        current.audioTimer = timer;
    }

    function decode(current, source, withAudio, failed, changed) {
        const scale = 'fps=' + fps + ',scale=' + w + ':' + h
            + ':force_original_aspect_ratio=decrease:out_color_matrix=bt709,pad=' + w + ':' + h + ':(ow-iw)/2:(oh-ih)/2';
        const args = input(source, current.network, withAudio).concat([
            '-map', '0:v:0', '-an', '-vf', scale, '-pix_fmt', preview ? 'rgba' : 'yuv420p', '-f', 'rawvideo', 'pipe:1'
        ]);
        if (withAudio) args.push('-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-f', 's16le', 'pipe:2');
        const video = decodeProcess(args, current.network);
        current.video = video;
        if (withAudio) playAudio(current, video.stderr, changed);
        else if (audio) changed('audio-unavailable');
        let diagnostic = '';
        if (!withAudio) video.stderr.on('data', (chunk) => {
            if (diagnostic.length < 400) diagnostic += String(chunk).slice(0, 400);
        });
        let offset = 0;
        let ready = false;
        const frame = Buffer.allocUnsafe(size);
        current.timer = setTimeout(() => failed('error', ready), 16000);
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
                } catch (_) { failed('unavailable'); return; }
                if (!ready) {
                    ready = true;
                    changed('playing');
                } else if (preview) changed('frame');
                if (job !== current || current.video !== video) return;
                clearTimeout(current.timer);
                current.timer = setTimeout(() => failed('error', ready), 12000);
            }
        });
        video.on('error', (error) => failed(error.code === 'ENOENT' ? 'unavailable' : 'error'));
        video.on('close', (code) => {
            if (job === current && current.video === video && code) {
                const http = /(?:HTTP error |Server returned )(\d{3})/.exec(diagnostic);
                log.warn('TDTWorld: FFmpeg terminó con código ' + code + (http ? ' (HTTP ' + http[1] + ')' : ''));
            }
            failed('error', ready);
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
            function attempt(source, withAudio) {
                if (job !== current) return;
                const fail = (status, decoded) => {
                    if (current !== job || current.video !== video) return;
                    current.video = null;
                    video.kill();
                    clear(current);
                    current.ring = current.sink = null;
                    if (status === 'error' && withAudio && !decoded) attempt(source, false);
                    else if (status === 'error' && index < sources.length) { changed('loading'); attempt(sources[index++], !!audio); }
                    else { stop(); changed(status); }
                };
                decode(current, source, withAudio, fail, changed);
                const video = current.video;
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
