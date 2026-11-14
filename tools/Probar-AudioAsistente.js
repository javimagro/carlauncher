'use strict';
// PC-only: a PCM receiver is not the speakers of the i4.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), assert = require('node:assert/strict');
const { createAudio } = require('../native/javi-carlab/assistant-audio');
async function main(ffmpeg) {
    if (!ffmpeg || !fs.existsSync(ffmpeg)) throw new Error('Indica la ruta del FFmpeg local');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-assistant-audio-'));
    const count = path.join(root, 'count.json'), sink = path.join(root, 'sink.js');
    fs.writeFileSync(sink, "let n=0;process.stdout.write('ready\\n');process.stdin.on('data',b=>{n+=b.length;require('fs').writeFileSync(process.argv[2],String(n))});");
    const states = [], audio = createAudio({ ffmpeg, playback: { command: process.execPath, args: [sink, count], handshake: true } }, (e) => states.push(e));
    try {
        const pcm = Buffer.alloc(24000 * 2 * 2);
        for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * 440 * 2 * Math.PI / 24000) * 1500), i * 2);
        audio.pcm(pcm.toString('base64')); audio.finish();
        const deadline = Date.now() + 8000;
        while (Date.now() < deadline && (!fs.existsSync(count) || Number(fs.readFileSync(count, 'utf8')) < 384000)) await new Promise((r) => setTimeout(r, 50));
        const bytes = fs.existsSync(count) ? Number(fs.readFileSync(count, 'utf8')) : 0;
        assert.equal(bytes, 384000, JSON.stringify(states));
        console.log('PCM: 96000 bytes mono 24 kHz -> 384000 bytes estéreo 48 kHz recibidos. No es una prueba de altavoces.');
    } finally { audio.close(); fs.rmSync(root, { recursive: true, force: true }); }
}
main(process.argv[2]).catch((e) => { console.error(e); process.exitCode = 1; });
