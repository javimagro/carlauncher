'use strict';

// PC smoke test only. No proxy credentials, source URLs or media are retained.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns');
const catalog = require('../native/javi-carlab/tdt-catalog');
const get = require('../native/javi-carlab/drivehub-network');
const { createIsolatedPlayer } = require('../native/javi-carlab/tdt-process');
const startProxy = require('../native/javi-carlab/tdt-proxy');

if (process.argv[2] === '--sink') {
    let bytes = 0;
    console.log('ready');
    process.stdin.on('data', (buffer) => {
        bytes += buffer.length;
        fs.writeFileSync(process.argv[3] + '.tmp', String(bytes));
        fs.renameSync(process.argv[3] + '.tmp', process.argv[3]);
    });
} else {
    const ffmpeg = process.argv[2], name = process.argv[3];
    if (!ffmpeg || !name) throw new Error('Uso: node tools/Probar-Canal-TDT.js RUTA_FFMPEG "La 1"');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-tdt-smoke-'));
    const countFile = path.join(directory, 'pcm-count');
    let player, network;
    async function main() {
        const entries = await catalog.loadCatalog('es', get);
        const channel = entries.find((item) => catalog.key(item.name) === catalog.key(name));
        if (!channel) throw new Error('Canal no encontrado');
        let sources = await catalog.resolveSources(channel, get);
        if (process.argv.includes('--dash')) sources = sources.filter((source) => /\.mpd(?:[?#]|$)/i.test(source));
        if (!sources.length) throw new Error('Sin fuente pública');
        let file, firstFrameMs = null, frames = 0, previousSequence = 0, lastHash, repeated = 0, maxRepeatedFrames = 0;
        network = await startProxy(dns.lookup);
        if (process.argv.includes('--original-dash')) delete network.dashUrl;
        const statuses = [], started = Date.now();
        player = createIsolatedPlayer({ video(id, value) { file = value; } }, {
            ffmpeg, directory, get, proxy: () => network, pacedInput: process.argv.includes('--paced'),
            audio: { command: process.execPath, args: [__filename, '--sink', countFile], handshake: true }
        });
        player.ready({ video: true });
        player.start(sources, (state, detail) => statuses.push([state, detail || '']));
        await new Promise((resolve) => {
            const timer = setInterval(() => {
                if (file) {
                    const fd = fs.openSync(file, 'r'), header = Buffer.alloc(24);
                    try {
                        fs.readSync(fd, header, 0, header.length, 0); frames = header.readUInt32LE(16);
                        if (frames !== previousSequence) {
                            const pixels = Buffer.alloc(header.readUInt32LE(8) * header.readUInt32LE(12) * 3 / 2);
                            fs.readSync(fd, pixels, 0, pixels.length, 64 + header.readUInt32LE(20) * pixels.length);
                            const hash = crypto.createHash('md5').update(pixels).digest('hex');
                            repeated = hash === lastHash ? repeated + 1 : 0;
                            maxRepeatedFrames = Math.max(maxRepeatedFrames, repeated); lastHash = hash; previousSequence = frames;
                        }
                    }
                    finally { fs.closeSync(fd); }
                    if (frames && firstFrameMs === null) firstFrameMs = Date.now() - started;
                }
                if (Date.now() - started >= 30000) { clearInterval(timer); resolve(); }
            }, 50);
        });
        const pcmBytes = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
        console.log(JSON.stringify({ channel: channel.name, platform: process.platform, runtime: process.version,
            pacedInput: process.argv.includes('--paced'), dashRelay: !!network.dashUrl, firstFrameMs, frames, maxRepeatedFrames,
            pcmBytes, stats: player.stats(), statuses, speakersVerified: false }, null, 2));
        if (!frames || !pcmBytes) process.exitCode = 1;
    }
    main().catch((error) => { console.error('Prueba no completada: ' + (error.code || 'fuente o proceso no disponible')); process.exitCode = 1; })
        .then(() => { if (player) player.stop(); else if (network) network.close(); });
}
