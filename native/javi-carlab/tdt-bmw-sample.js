'use strict';

// An explicit, finite A/V test. A complete WAV proves the native route separately
// from live transport; it must never be described as a continuous TDT backend.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { createRing, hlsProgram } = require('./tdt-player');
const { selectDash } = require('./tdt-dash');
const W = 320, H = 180, FPS = 20, FRAME = W * H * 3 / 2, PCM_SECOND = 48000 * 4;
const messages = {
    bridge: 'BMW · puente de audio no disponible', service: 'BMW · servicio no disponible',
    route: 'BMW · fuente o salida no reconocida', busy: 'BMW · fuente ocupada por otra app',
    connections: 'BMW · no se pueden consultar las conexiones', connect: 'BMW · conexión rechazada',
    play: 'BMW · archivo rechazado', clock: 'BMW · reloj sin avance', read: 'BMW · error al consultar el reproductor'
};

function wavHeader(bytes) {
    const h = Buffer.alloc(44);
    h.write('RIFF', 0); h.writeUInt32LE(bytes + 36, 4); h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
    h.writeUInt32LE(48000, 24); h.writeUInt32LE(PCM_SECOND, 28);
    h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(bytes, 40);
    return h;
}
function write(fd, bytes, offset) {
    for (let at = 0; at < bytes.length;) {
        const n = fs.writeSync(fd, bytes, at, bytes.length - at, offset + at);
        if (!n) throw new Error('sample-write');
        at += n;
    }
}
function createSamplePlayer(gpu, options) {
    const duration = options.sampleSeconds || 30;
    if (!Number.isInteger(duration) || duration < 1 || duration > 30) throw new Error('Duración de prueba inválida');
    const directory = options.directory || '/dev/shm';
    const send = options.nativeSend;
    const spawnProcess = options.spawnProcess || spawn;
    const epoch = process.hrtime();
    const clock = () => { const t = process.hrtime(epoch); return t[0] * 1000 + t[1] / 1e6; };
    let job, capable = false, surface;
    function stop() {
        const j = job; job = null; surface = undefined;
        if (!j) return;
        clearTimeout(j.deadline); clearInterval(j.timer);
        send({ type: 'native-stop', id: j.id });
        if (j.child) {
            j.child.kill();
            const force = setTimeout(() => { if (j.child.exitCode === null) j.child.kill('SIGKILL'); }, 500); force.unref();
        }
        if (j.network && j.network.close) j.network.close();
        if (j.ring) { gpu.video(1, null); try { j.ring.close(); } catch (_) {} }
        for (const key of ['audioFd', 'videoFd']) if (j[key] !== undefined) { try { fs.closeSync(j[key]); } catch (_) {} j[key] = undefined; }
        for (const file of [j.audioFile, j.videoFile]) if (file) { try { fs.unlinkSync(file); } catch (_) {} }
        if (j.dir) { try { fs.rmdirSync(j.dir); } catch (_) {} }
    }
    function fail(j, detail) {
        if (job !== j) return;
        stop(); j.changed('error', detail);
    }
    async function capture(j, sources) {
        try {
            j.network = options.proxy && await options.proxy();
            if (job !== j) { if (j.network && j.network.close) j.network.close(); return; }
            let source = sources[0], program;
            if (typeof source !== 'string' || !/^https?:\/\//.test(source)) throw new Error('source');
            if (options.get && /\.m3u8(?:[?#]|$)/i.test(source)) {
                try { program = hlsProgram(await options.get(source, 256 * 1024, 4000), W, H); } catch (_) {}
            }
            if (options.get && j.network && j.network.dashUrl && /\.mpd(?:[?#]|$)/i.test(source)) {
                const bytes = await options.get(source, 256 * 1024, 4000);
                selectDash(bytes, source, (url) => url, W, H);
                source = j.network.dashUrl + encodeURIComponent(source);
            }
            if (job !== j) return;
            j.dir = path.join(directory, 'bmw-tdt-native-' + j.id);
            fs.mkdirSync(j.dir, 0o755);
            fs.chmodSync(j.dir, 0o755);
            send({ type: 'sample-dir', id: j.id, directory: j.dir });
            j.audioFile = path.join(j.dir, 'audio.wav'); j.videoFile = path.join(j.dir, 'video.i420');
            j.audioFd = fs.openSync(j.audioFile, 'wx+', 0o644);
            fs.fchmodSync(j.audioFd, 0o644);
            j.videoFd = fs.openSync(j.videoFile, 'wx+', 0o600);
            write(j.audioFd, wavHeader(0), 0);
            let audioBytes = 0, videoBytes = 0;
            const relayed = j.network && j.network.dashUrl && source.indexOf(j.network.dashUrl) === 0;
            const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-rw_timeout', '8000000'];
            if (j.network && !relayed) args.push('-http_proxy', j.network.url);
            if (options.caFile && !relayed) args.push('-tls_verify', '1');
            args.push('-protocol_whitelist', relayed ? 'http,tcp' : 'http,https,tcp,tls,httpproxy,crypto', '-i', source);
            const selector = program === undefined ? '0:' : '0:p:' + program + ':';
            args.push('-map', selector + 'v:0', '-t', String(duration), '-an', '-vf',
                'fps=20:start_time=0,scale=320:180:force_original_aspect_ratio=decrease:out_color_matrix=bt709,pad=320:180:(ow-iw)/2:(oh-ih)/2',
                '-pix_fmt', 'yuv420p', '-f', 'rawvideo', 'pipe:1',
                '-map', selector + 'a:0', '-t', String(duration), '-vn', '-ac', '2', '-ar', '48000',
                '-af', 'aresample=async=1:first_pts=0', '-f', 's16le', 'pipe:3');
            const childOptions = { stdio: ['ignore', 'pipe', 'pipe', 'pipe'], env: Object.assign({}, process.env, { no_proxy: '127.0.0.1' }) };
            if (options.caFile) childOptions.env.SSL_CERT_FILE = options.caFile;
            if (j.network && j.network.uid) { childOptions.uid = j.network.uid; childOptions.gid = j.network.uid; }
            const child = j.child = spawnProcess(options.ffmpeg || 'ffmpeg', args, childOptions);
            child.stderr.on('data', () => {}); // Never disclose source credentials.
            child.stdout.on('data', (bytes) => {
                if (job !== j) return;
                try {
                    if (videoBytes + bytes.length > duration * FPS * FRAME) throw new Error('limit');
                    write(j.videoFd, bytes, videoBytes); videoBytes += bytes.length;
                } catch (_) { fail(j, 'Prueba BMW · no se puede guardar la imagen'); }
            });
            child.stdio[3].on('data', (bytes) => {
                if (job !== j) return;
                try {
                    if (audioBytes + bytes.length > duration * PCM_SECOND) throw new Error('limit');
                    write(j.audioFd, bytes, 44 + audioBytes); audioBytes += bytes.length;
                } catch (_) { fail(j, 'Prueba BMW · no se puede guardar el audio'); }
            });
            child.on('error', () => fail(j, 'Prueba BMW · decodificador no disponible'));
            child.on('close', (code) => {
                if (job !== j) return;
                j.child = null;
                const frames = Math.min(Math.floor(videoBytes / FRAME), Math.floor(audioBytes / (PCM_SECOND / FPS)));
                if (code !== 0 || frames < FPS || videoBytes % FRAME || audioBytes % 4) { fail(j, 'Prueba BMW · muestra incompleta o sin audio'); return; }
                try {
                    const pcmBytes = frames * PCM_SECOND / FPS;
                    fs.ftruncateSync(j.audioFd, 44 + pcmBytes); write(j.audioFd, wavHeader(pcmBytes), 0);
                    fs.fsyncSync(j.audioFd); fs.closeSync(j.audioFd); j.audioFd = undefined;
                    j.frames = frames; j.frame = Buffer.alloc(FRAME); j.lastFrame = -1;
                    j.ring = createRing(directory, W, H); gpu.video(1, j.ring.file); surface = { id: 1 };
                    if (fs.readSync(j.videoFd, j.frame, 0, FRAME, 0) !== FRAME) throw new Error('short');
                    j.ring.push(j.frame);
                    clearTimeout(j.deadline);
                    j.deadline = setTimeout(() => fail(j, 'BMW · prueba agotada o reloj detenido'), (duration + 20) * 1000);
                    j.changed('native-waiting');
                    send({ type: 'native-play', id: j.id, path: j.audioFile });
                    j.timer = setInterval(() => {
                        if (job !== j || !j.time) return;
                        if (clock() - j.time.at > 5000) { fail(j, messages.clock); return; }
                        const elapsed = j.time.elapsed + (j.time.playing ? Math.min(800, clock() - j.time.at) : 0);
                        const index = Math.max(j.lastFrame, Math.min(frames - 1, Math.floor(elapsed * FPS / 1000)));
                        if (index === j.lastFrame) return;
                        try {
                            if (fs.readSync(j.videoFd, j.frame, 0, FRAME, index * FRAME) !== FRAME) throw new Error('short');
                            j.ring.push(j.frame); j.lastFrame = index;
                        } catch (_) { fail(j, 'Prueba BMW · error de imagen'); }
                    }, 50);
                } catch (_) { fail(j, 'Prueba BMW · archivo no preparado'); }
            });
        } catch (_) { fail(j, 'Prueba BMW · no se puede preparar el canal'); }
    }
    return {
        ready(info) { capable = !!(info && info.video && gpu.video); },
        frame: () => surface, stop,
        start(sources, changed) {
            stop();
            if (!capable || !send) { changed('unavailable'); return; }
            const j = job = { id: crypto.randomBytes(8).toString('hex'), changed };
            changed('native-recording');
            j.deadline = setTimeout(() => fail(j, 'Prueba BMW · tiempo de preparación agotado'), 65000);
            capture(j, sources);
        },
        nativeStatus(message) {
            const j = job;
            if (!j || !message || message.id !== j.id) return;
            if (message.state === 'error') {
                const code = typeof message.result === 'string' && /^[A-Z0-9_]{1,40}$/.test(message.result) ? ' (' + message.result + ')' : '';
                fail(j, (messages[message.code] || 'BMW · error de reproducción') + code); return;
            }
            if (message.state === 'ended') { stop(); j.changed('native-ended'); return; }
            if ((message.state === 'playing' || message.state === 'paused') && Number.isFinite(message.elapsed) && message.elapsed >= 0 && message.elapsed <= 32000) {
                j.time = { elapsed: message.elapsed, at: clock(), playing: message.state === 'playing' };
                if (!j.announced) { j.announced = true; j.changed('playing'); j.changed('audio-native-sample'); }
            }
        }
    };
}
module.exports = { createSamplePlayer, wavHeader };
