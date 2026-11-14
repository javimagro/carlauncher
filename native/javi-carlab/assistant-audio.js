'use strict';

// Runs outside the drawing thread. Native FFmpeg converts PCM; a bounded queue paces ALSA.
const { spawn, fork } = require('child_process');
const playAudio = require('./tdt-audio');
function createAudio(options, emit, dependencies) {
    const launch = dependencies && dependencies.spawn || spawn;
    let converter, sink, capture, timer, stopped = false, failed = false, finishing = false, finished = false, bytes = 0, inputQueued = 0, chunks = [], captureBytes = 0, captureTimer;
    let captureTail = Buffer.alloc(0);
    function terminate(peer) {
        if (!peer) return;
        peer.kill();
        const force = setTimeout(() => { if (peer.exitCode === null) peer.kill('SIGKILL'); }, 500);
        force.unref(); peer.once('close', () => clearTimeout(force));
    }
    function stopOutput() {
        clearInterval(timer); timer = null; chunks = []; bytes = 0;
        if (sink) sink.close(); sink = null;
        const old = converter; converter = null; terminate(old);
    }
    function outputError() { if (failed) return; failed = true; stopOutput(); emit({ type: 'audio-status', message: 'No hay salida de voz disponible; la respuesta sigue en pantalla' }); }
    function output() {
        if (converter || stopped || failed || !options.playback) return;
        finishing = finished = false;
        converter = launch(options.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-probesize', '32', '-analyzeduration', '0',
            '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
        const process = converter;
        process.on('error', () => { if (converter === process) outputError(); });
        process.on('close', (code) => {
            if (converter !== process) return;
            if (code === 0 && finishing) { converter = null; finished = true; }
            else outputError();
        });
        process.stdin.on('error', () => { if (converter === process) outputError(); });
        const queue = { push(buffer) {
            if (bytes + buffer.length > 1152000) { outputError(); return; }
            chunks.push(buffer); bytes += buffer.length;
        } };
        sink = playAudio(process.stdout, (status) => {
            if (status !== 'audio-ready' && status !== 'audio-connecting') outputError();
            else if (status === 'audio-ready') emit({ type: 'audio-status', message: 'Voz enviada a la salida multimedia; sonido pendiente de confirmar' });
        }, queue, Object.assign({}, options.playback, { maxRetries: 0 }), launch, { warn() {} });
        if (failed || stopped) { sink.close(); sink = null; return; }
        timer = setInterval(() => {
            if (finished && !bytes) { stopOutput(); emit({ type: 'audio-status', message: 'Respuesta entregada a la salida multimedia' }); return; }
            if (!sink || !sink.stats().ready || sink.stats().blocked || !bytes) return;
            let remaining = Math.min(3840, bytes); // 20 ms, 48 kHz stereo PCM16.
            remaining -= remaining % 4;
            const buffer = Buffer.alloc(remaining); let offset = 0;
            while (remaining && chunks.length) {
                const head = chunks[0], length = Math.min(remaining, head.length);
                head.copy(buffer, offset, 0, length); offset += length; remaining -= length; bytes -= length;
                if (length === head.length) chunks.shift(); else chunks[0] = head.slice(length);
            }
            if (buffer.length) sink.write(buffer);
        }, 20);
    }
    function finishCapture() {
        clearTimeout(captureTimer);
        const old = capture; capture = null; terminate(old);
        emit({ type: 'capture-end', samples: captureBytes / 2 }); captureBytes = 0;
    }
    return {
        finish() { if (converter && !finishing) { finishing = true; converter.stdin.end(); } },
        pcm(data) {
            if (stopped || failed || !options.playback || typeof data !== 'string' || data.length > 192000) return;
            output();
            if (!converter) return;
            const pcm = Buffer.from(data, 'base64');
            if (inputQueued + pcm.length > 384000) { outputError(); return; }
            inputQueued += pcm.length; converter.stdin.write(pcm, () => { inputQueued -= pcm.length; });
        },
        listen() {
            if (stopped) return;
            if (capture) { finishCapture(); return; }
            if (!options.capture) { emit({ type: 'audio-status', message: 'Micrófono de la MGU pendiente de validar' }); return; }
            stopOutput(); captureBytes = 0; captureTail = Buffer.alloc(0);
            capture = launch(options.capture.command, options.capture.args, { stdio: ['ignore', 'pipe', 'ignore'] });
            const process = capture;
            capture.on('error', () => { if (capture === process) { finishCapture(); emit({ type: 'audio-status', message: 'No se pudo abrir el micrófono' }); } });
            capture.on('close', () => { if (capture === process) finishCapture(); });
            capture.stdout.on('data', (buffer) => {
                if (capture !== process) return;
                if (captureTail.length) buffer = Buffer.concat([captureTail, buffer]);
                const length = buffer.length - buffer.length % 2;
                captureTail = length < buffer.length ? Buffer.from(buffer.slice(length)) : Buffer.alloc(0);
                // Both IPC peers accept at most 64,000 base64 characters (48 kB PCM16).
                for (let offset = 0; offset < length; offset += 48000) {
                    const part = buffer.slice(offset, Math.min(offset + 48000, length));
                    captureBytes += part.length; emit({ type: 'capture', data: part.toString('base64') });
                }
            });
            captureTimer = setTimeout(finishCapture, 30000);
        },
        close() { stopped = true; clearTimeout(captureTimer); const old = capture; capture = null; terminate(old); stopOutput(); }
    };
}
function isolatedAudio(options, emit) {
    let closed = false, queued = 0;
    const worker = fork(__filename, [], { silent: true }); worker.stdout.resume(); worker.stderr.resume();
    function close() {
        if (closed) return; closed = true;
        // Let the owner reap FFmpeg/ALSA/capture before terminating the IPC process.
        if (worker.connected) worker.send({ op: 'close' }, (error) => { if (error) worker.kill(); });
        else worker.kill();
        const force = setTimeout(() => { if (worker.exitCode === null) worker.kill('SIGKILL'); }, 1200);
        force.unref(); worker.once('exit', () => clearTimeout(force));
    }
    worker.on('message', (m) => { if (!closed) emit(m); });
    worker.on('error', () => { if (!closed) emit({ type: 'audio-error', message: 'Audio no disponible' }); close(); });
    worker.on('exit', () => { if (!closed) emit({ type: 'audio-error', message: 'Audio no disponible' }); close(); });
    function send(m) {
        if (closed || !worker.connected) return;
        if (++queued > 24) { emit({ type: 'audio-error', message: 'Audio saturado; respuesta en pantalla' }); close(); return; }
        worker.send(m, () => { queued--; });
    }
    send({ op: 'start', options });
    return { close, finish() { send({ op: 'finish' }); }, pcm(data) { send({ op: 'pcm', data }); }, listen() { send({ op: 'listen' }); } };
}
if (require.main === module) {
    let audio, queued = 0, ending = false;
    function shutdown() {
        if (ending) return; ending = true;
        if (audio) audio.close();
        if (process.connected) process.disconnect();
        // Child handles keep the loop alive until their bounded termination completes.
    }
    const emit = (m) => {
        if (!process.connected) return;
        if (++queued > 24) { process.exitCode = 1; shutdown(); return; }
        process.send(m, () => { queued--; });
    };
    process.on('message', (m) => {
        if (ending) return;
        if (m.op === 'close') { shutdown(); return; }
        if (m.op === 'start' && !audio) audio = createAudio(m.options, emit);
        else if (audio && m.op === 'pcm') audio.pcm(m.data);
        else if (audio && m.op === 'listen') audio.listen();
        else if (audio && m.op === 'finish') audio.finish();
    });
    process.on('disconnect', shutdown);
    process.on('SIGTERM', shutdown);
}
module.exports = { createAudio, isolatedAudio };
