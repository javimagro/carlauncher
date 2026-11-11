'use strict';

const crypto = require('crypto');
const http = require('http');
const net = require('net');
const { URL } = require('url');
const { lookupForUplink } = require('./drivehub-network.js');
const { mediaUrl } = require('./tdt-catalog.js');

function startProxy(lookup) {
    const secret = crypto.randomBytes(24).toString('hex');
    const authorization = 'Basic ' + Buffer.from('tdt:' + secret).toString('base64');
    const sockets = new Set();
    function track(socket) {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.setTimeout(15000, () => socket.destroy());
        return socket;
    }

    const server = http.createServer((req, res) => {
        const target = mediaUrl(req.url);
        if (req.headers['proxy-authorization'] !== authorization) {
            res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="TDTWorld"' }).end();
            return;
        }
        if (!target.startsWith('http://') || !['GET', 'HEAD'].includes(req.method)) {
            res.writeHead(403).end();
            return;
        }
        const url = new URL(target);
        const headers = Object.assign({}, req.headers, { host: url.host, connection: 'close' });
        delete headers['proxy-authorization'];
        delete headers['proxy-connection'];
        const upstream = http.request({ hostname: url.hostname, lookup, path: url.pathname + url.search,
            method: req.method, headers }, (reply) => {
            res.writeHead(reply.statusCode, reply.headers);
            reply.on('error', () => res.destroy());
            reply.pipe(res);
        });
        upstream.on('socket', track);
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(502).end();
            else res.destroy();
        });
        res.on('close', () => upstream.destroy());
        upstream.end();
    });
    server.on('connection', track);
    server.on('connect', (req, client, head) => {
        if (req.headers['proxy-authorization'] !== authorization) {
            client.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="TDTWorld"\r\n\r\n');
            return;
        }
        if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}:443$/i.test(req.url)) {
            client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
            return;
        }
        const upstream = track(net.connect({ host: req.url.slice(0, -4), port: 443, lookup }, () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head.length) upstream.write(head);
            client.pipe(upstream).pipe(client);
        }));
        upstream.on('error', () => client.destroy());
        client.on('error', () => upstream.destroy());
        client.on('close', () => upstream.destroy());
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            url: 'http://tdt:' + secret + '@127.0.0.1:' + server.address().port,
            close() {
                for (const socket of sockets) socket.destroy();
                server.close();
            }
        }));
    });
}

if (require.main === module) {
    Promise.resolve().then(() => startProxy(lookupForUplink())).then((proxy) => {
        process.once('disconnect', () => proxy.close());
        process.send(proxy.url);
    }, () => { process.exitCode = 1; if (process.connected) process.disconnect(); });
}

module.exports = startProxy;
