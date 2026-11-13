'use strict';

const fs = require('fs');
const net = require('net');

function consume(receive) {
    let partial = Buffer.alloc(0);
    return (chunk) => {
        if (chunk.length > 256) return false;
        const bytes = partial.length ? Buffer.concat([partial, chunk]) : chunk;
        let i = 0;
        for (; i + 4 <= bytes.length; i += 4) {
            receive({ knob: bytes.readUInt16BE(i), press: bytes[i + 2], tilt: bytes[i + 3] });
        }
        partial = bytes.slice(i);
        return true;
    };
}

function listen(endpoint, receive, stopped, readFrom = consume, disconnected = () => {}) {
    let owner = 0;
    let peer;
    let ready = false;
    try {
        if (fs.lstatSync(endpoint).isSocket()) fs.unlinkSync(endpoint);
    } catch (err) { if (err.code !== 'ENOENT') throw err; }

    function restrict() {
        fs.chmodSync(endpoint, 0o600);
        fs.chownSync(endpoint, owner, 0);
    }
    function dropPeer() {
        if (!peer) return;
        peer.destroy();
        peer = undefined;
        disconnected();
    }
    const server = net.createServer((socket) => {
        dropPeer();
        peer = socket;
        const read = readFrom(receive);
        socket.on('data', (chunk) => { if (peer !== socket || !read(chunk)) socket.destroy(); });
        socket.on('error', () => {});
        socket.on('close', () => {
            if (peer !== socket) return;
            peer = undefined;
            disconnected();
        });
    });
    server.on('error', stopped);
    server.listen(endpoint, () => {
        ready = true;
        try { restrict(); } catch (err) { stopped(err); }
    });
    return {
        send(message) {
            if (!peer || peer.destroyed || peer.bufferSize || typeof message !== 'string' || Buffer.byteLength(message) > 65536) return false;
            peer.write(message, 'utf8');
            return true;
        },
        setOwner(uid) {
            if (uid === owner) return;
            owner = uid;
            dropPeer();
            if (ready) restrict();
        },
        close() { dropPeer(); server.close(); }
    };
}

module.exports = { consume, listen };
