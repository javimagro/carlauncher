'use strict';

// Deterministic, offline transport + real FFmpeg DASH demux/decoding. The
// HTTPS transport is a fixture; this is neither a TLS nor a car speaker test.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { EventEmitter } = require('events');
const { execFileSync, spawn } = require('child_process');
const createRelay = require('../native/javi-carlab/tdt-dash-relay');
const { createPlayer } = require('../native/javi-carlab/tdt-player');
const ffmpeg = process.argv[2];
if (!ffmpeg) throw new Error('Uso: node tools/Probar-DASH-TDT.js RUTA_FFMPEG');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-dash-test-'));
execFileSync(ffmpeg, ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=20',
    '-f', 'lavfi', '-i', 'sine=sample_rate=48000', '-t', '12', '-map', '0:v', '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-s:v:0', '320x180', '-s:v:1', '640x360',
    '-b:v:0', '200k', '-b:v:1', '500k', '-c:a', 'aac', '-metadata:s:a:0', 'language=spa',
    '-seg_duration', '1', '-use_timeline', '1', '-use_template', '1', '-adaptation_sets', 'id=0,streams=v id=1,streams=a',
    '-f', 'dash', 'manifest.mpd'], { cwd: directory });
let reads = 0, cancelled = 0;
const relay = createRelay(undefined, (options, callback) => {
    if (!options.rejectUnauthorized || options.protocol !== 'https:') throw new Error('TLS requerido');
    const req = new EventEmitter(); let stream;
    req.destroy = () => { cancelled++; if (stream) stream.destroy(); };
    req.end = () => setImmediate(() => {
        const name = options.path.slice(1);
        if (process.argv.includes('--debug')) console.error('FIXTURE_READ ' + name);
        if (!/^[a-zA-Z0-9_.-]+$/.test(name)) { req.emit('error', new Error('Ruta inválida')); return; }
        const file = path.join(directory, name);
        fs.stat(file, (error, stat) => {
            if (error) { req.emit('error', error); return; }
            reads++;
            stream = fs.createReadStream(file);
            stream.statusCode = 200; stream.headers = { 'content-length': String(stat.size) };
            callback(stream);
        });
    });
    return req;
});
const server = http.createServer((req, res) => { if (!relay.handle(req, res)) { res.writeHead(404); res.end(); } });
const sockets = new Set(); server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
server.listen(0, '127.0.0.1', () => {
    const dashUrl = relay.attach('http://127.0.0.1:' + server.address().port);
    const network = { dashUrl, close() { relay.close(); for (const s of sockets) s.destroy(); server.close(); } };
    let ring, stats, firstFrameMs, frames = 0;
    const started = Date.now(), statuses = [];
    const player = createPlayer({ video(id, file) { ring = file; } }, { ffmpeg, directory, proxy: () => network,
        get: () => Promise.resolve(fs.readFileSync(path.join(directory, 'manifest.mpd'))), onStats: (s) => { stats = s; },
        spawnProcess(command, args, options) {
            if (process.argv.includes('--debug')) args[args.indexOf('-loglevel') + 1] = 'debug';
            const child = spawn(command, args, options);
            child.stderr.on('data', (b) => process.stderr.write(String(b).replace(/https?:\/\/\S+/g, '[fixture]')));
            return child;
        } });
    player.ready({ video: true }); player.start(['https://fixture.example.org/manifest.mpd'], (s) => statuses.push(s));
    const timer = setInterval(() => {
        if (ring) {
            const fd = fs.openSync(ring, 'r'), header = Buffer.alloc(4);
            try { fs.readSync(fd, header, 0, 4, 16); frames = header.readUInt32LE(0); } finally { fs.closeSync(fd); }
            if (firstFrameMs === undefined && frames) firstFrameMs = Date.now() - started;
        }
        if (frames < 130 && Date.now() - started < 20000 && !statuses.includes('error')) return;
        clearInterval(timer); player.stop();
        console.log(JSON.stringify({ runtime: process.version, platform: process.platform, firstFrameMs, frames, reads, cancelled,
            stats, statuses, transport: 'offline fixture', speakersVerified: false }, null, 2));
        if (frames < 130 || !stats || !stats.dashAdapted || stats.underruns || statuses.includes('error')) process.exitCode = 1;
    }, 20);
});
