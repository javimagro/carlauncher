'use strict';
const net = require('net');
const { StringDecoder } = require('string_decoder');
const { createAudio } = require('./audio-bmw.js');

function report(builders) {
    let visible = false, socket, timer, release, closing = Promise.resolve();
    function connect() {
        if (!visible || socket) return;
        const peer = net.connect('/run/javi-carlab/audio.sock');
        socket = peer;
        let partial = '', audio;
        const dispose = () => { if (audio) { closing = audio.close().catch(() => {}); audio = null; } return closing; };
        release = dispose;
        const decoder = new StringDecoder('utf8');
        peer.on('connect', () => {
            closing.then(() => {
                if (!visible || peer !== socket || peer.destroyed) return;
                audio = createAudio(builders, (value) => {
                    if (!peer.destroyed && !peer.bufferSize) peer.write(JSON.stringify(value) + '\n');
                });
                peer.write('{"state":"ready"}\n');
            });
        });
        peer.on('data', (chunk) => {
            if (!audio || chunk.length > 4096) { peer.destroy(); return; }
            partial += decoder.write(chunk);
            if (Buffer.byteLength(partial) > 4096) { peer.destroy(); return; }
            let at;
            while ((at = partial.indexOf('\n')) >= 0) {
                const line = partial.slice(0, at); partial = partial.slice(at + 1);
                try { audio.command(JSON.parse(line)); } catch (_) { peer.destroy(); return; }
            }
        });
        peer.on('error', () => {});
        peer.on('close', () => {
            if (peer === socket) socket = null;
            dispose();
        });
    }
    function show(on) {
        if (visible === on) return;
        visible = on;
        if (on) { timer = setInterval(connect, 1000); connect(); }
        else { clearInterval(timer); if (release) release(); if (socket) socket.destroy(); }
    }
    return { show, close() { show(false); return closing; } };
}
module.exports = { report };
