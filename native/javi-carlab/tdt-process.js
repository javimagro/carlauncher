'use strict';

const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');

// Only control, paths and counters cross IPC; raw video stays in /dev/shm.
function createIsolatedPlayer(gpu, options) {
    let capable = false, job, surface, counters;
    function stop() {
        const old = job;
        job = null;
        surface = counters = undefined;
        if (!old) return;
        gpu.video(1, null);
        if (old.ring) fs.unlink(old.ring, () => {});
        if (old.network) old.network.close();
        if (old.child) {
            if (old.child.connected) old.child.disconnect();
            const force = setTimeout(() => { if (old.child.exitCode === null) old.child.kill('SIGKILL'); }, 1500);
            force.unref();
        }
    }
    return {
        ready(info) { capable = !!(info && info.video && gpu.video); },
        frame: () => surface,
        stats: () => counters,
        stop,
        start(sources, changed) {
            stop();
            if (!capable) { changed('unavailable'); return; }
            const current = {};
            job = current;
            Promise.resolve().then(() => options.proxy && options.proxy()).then((network) => {
                if (job !== current) { if (network) network.close(); return; }
                current.network = network;
                const child = (options.forkProcess || fork)(path.join(__dirname, 'tdt-worker.js'), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
                current.child = child;
                child.stderr.on('data', () => {}); // No stream URLs or proxy credentials in application logs.
                function fail() { if (job === current) { stop(); changed('error', 'proceso multimedia'); } }
                child.on('error', fail);
                child.on('exit', fail);
                child.on('message', (message) => {
                    if (job !== current || !message) return;
                    if (message.type === 'video') {
                        if (message.file && (path.dirname(path.resolve(message.file)) !== path.resolve(options.directory || '/dev/shm') ||
                            !/^mgu-video-bmwlauncher-[a-f0-9]{16}$/.test(path.basename(message.file)))) { fail(); return; }
                        if (message.file) current.ring = message.file;
                        gpu.video(1, message.file);
                        surface = message.file ? { id: 1 } : undefined;
                    } else if (message.type === 'status') {
                        if (message.status === 'error' || message.status === 'unavailable') stop();
                        changed(message.status, message.detail);
                    }
                    else if (message.type === 'stats') counters = message.value;
                    else if (message.type === 'manifest') {
                        Promise.resolve().then(() => options.get && options.get(message.url, 256 * 1024, 4000)).then((bytes) => {
                            if (job === current && child.connected) child.send({ type: 'manifest', id: message.id, data: bytes ? bytes.toString('base64') : null });
                        }, () => { if (job === current && child.connected) child.send({ type: 'manifest', id: message.id }); });
                    }
                });
                child.send({ type: 'start', sources, network: network && { uid: network.uid, url: network.url, dashUrl: network.dashUrl },
                    options: { ffmpeg: options.ffmpeg, caFile: options.caFile, audio: options.audio, directory: options.directory,
                        bufferSeconds: options.bufferSeconds, pacedInput: options.pacedInput } });
            }).catch(() => { if (job === current) { stop(); changed('error', 'inicio multimedia'); } });
        }
    };
}

module.exports = { createIsolatedPlayer };
