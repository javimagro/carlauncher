'use strict';

// Deterministic HLS jitter + PCM + a blocked UI. No vehicle or remote stream.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, fork } = require('child_process');
const { createIsolatedPlayer } = require('../native/javi-carlab/tdt-process');
const { createPlayer } = require('../native/javi-carlab/tdt-player');

if (process.argv[2] === '--server') {
    const directory = process.argv[3];
    let failed = false;
    const server = http.createServer((req, res) => {
        const name = req.url.slice(1);
        if (!/^sample(?:\d+\.ts|\.m3u8)$/.test(name)) { res.writeHead(404); res.end(); return; }
        if (name === 'sample4.ts' && !failed) { failed = true; process.send({ fault: 503 }); res.writeHead(503); res.end(); return; }
        const ms = name === 'sample8.ts' || name === 'sample11.ts' ? 1400 : 0;
        setTimeout(() => fs.readFile(path.join(directory, name), (err, bytes) => {
            res.writeHead(err ? 404 : 200); res.end(err ? '' : bytes);
        }), ms);
    });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
    process.once('disconnect', () => { server.close(); process.exit(0); });
} else if (process.argv[2] === '--sink') {
    let bytes = 0;
    if (process.argv[4] === '--block') setInterval(() => {}, 1000);
    console.log('ready');
    process.stdin.on('data', (chunk) => { bytes += chunk.length; fs.writeFileSync(process.argv[3], String(bytes));
        if (process.argv[4] === '--block' && bytes >= 48000 * 4) process.stdin.pause(); });
} else {
    const ffmpeg = process.argv[2];
    if (!ffmpeg) throw new Error('Uso: node tools/Probar-Reproduccion.js RUTA_FFMPEG [--inline]');
    const isolated = !process.argv.includes('--inline');
    const blockAudio = process.argv.includes('--block-audio'), noAudio = process.argv.includes('--no-audio');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-playback-audit-'));
    execFileSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=20',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '16', '-c:v', 'libx264', '-g', '20',
        '-c:a', 'aac', '-hls_time', '1', '-hls_list_size', '0', '-f', 'hls', path.join(directory, 'sample.m3u8')]);
    const server = fork(__filename, ['--server', directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    const audioFile = path.join(directory, 'audio-count');
    let ring, seq = 0, blocked = false, advancesWhileBlocked = 0, stats, faults = 0, firstFrameMs = null;
    const gaps = []; let previousFrameAt = 0;
    const statuses = [];
    const factory = isolated ? createIsolatedPlayer : createPlayer;
    const player = factory({ video(id, file) { ring = file; } }, { directory, ffmpeg,
        audio: noAudio ? undefined : { command: process.execPath, args: [__filename, '--sink', audioFile].concat(blockAudio ? ['--block'] : []), handshake: true },
        onStats: (value) => { stats = value; } });
    const header = Buffer.alloc(4);
    const readSequence = () => {
        const fd = fs.openSync(ring, 'r');
        try { fs.readSync(fd, header, 0, 4, 16); return header.readUInt32LE(0); }
        finally { fs.closeSync(fd); }
    };
    const start = Date.now();
    server.on('message', (event) => { if (event && event.fault) faults++; });
    server.once('message', (port) => {
        player.ready({ video: true });
        player.start(['http://127.0.0.1:' + port + '/sample.m3u8'], (state, detail) => statuses.push([state, detail || '']));
        const timer = setInterval(() => {
            if (ring) { const next = readSequence(); if (next !== seq) {
                const at = Date.now(); if (firstFrameMs === null) firstFrameMs = at - start;
                if (previousFrameAt) gaps.push(at - previousFrameAt); previousFrameAt = at; seq = next;
            } }
            if (seq >= 70 && !blocked) {
                blocked = true;
                const before = seq, until = Date.now() + 650;
                while (Date.now() < until) { /* Reproduce UI CPU starvation. */ }
                advancesWhileBlocked = readSequence() - before;
            }
            if (seq < 250 && Date.now() - start < 35000) return;
            clearInterval(timer);
            if (player.stats) stats = player.stats();
            const pcmBytes = fs.existsSync(audioFile) ? Number(fs.readFileSync(audioFile, 'utf8')) : 0;
            player.stop();
            if (server.connected) server.disconnect();
            gaps.sort((a, b) => a - b);
            console.log(JSON.stringify({ isolated, blockAudio, noAudio, faults, firstFrameMs,
                ringObservedGapMs: { p50: gaps[Math.floor(gaps.length * .5)], p95: gaps[Math.floor(gaps.length * .95)], max: gaps[gaps.length - 1] },
                frames: seq, pcmBytes, advancesWhileBlocked, stats, statuses }, null, 2));
            if (seq < 250 || (!noAudio && !pcmBytes) || faults !== 1 || (isolated && advancesWhileBlocked < 8)) process.exitCode = 1;
        }, 20);
    });
    server.on('error', (error) => { player.stop(); console.error(error.message); process.exitCode = 1; });
}
