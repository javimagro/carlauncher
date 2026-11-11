'use strict';

const { fork } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const home = process.argv.includes('--drivehub');
const live = process.argv.includes('--live');
const [requestedPort, kitPath, storePath] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const { width, height } = home ? require('../../native/javi-carlab/drivehub-state') : require('../launcher-view');

const projects = path.resolve(__dirname, '../../..');
const kit = path.resolve(kitPath || path.join(projects, 'idrive7-apps'));
const store = path.resolve(storePath || path.join(projects, 'mgu-store-official'));
const port = Number(requestedPort || 18078);
const host = `127.0.0.1:${port}`;
const pipe = `\\\\.\\pipe\\carlauncher-split-${process.pid}`;
const gfx = path.join(kit, 'kit/emu/web/gfx');
const files = new Map([
    ['/', [path.join(__dirname, 'index.html'), 'text/html; charset=utf-8']],
    ['/preview.js', [path.join(__dirname, 'preview.js'), 'text/javascript; charset=utf-8']],
    ['/gfx/mgu-gfx.js', [path.join(gfx, 'mgu-gfx.js'), 'text/javascript']],
    ['/gfx/mgu-gfx-wasm.js', [path.join(gfx, 'mgu-gfx-wasm.js'), 'text/javascript']],
    ['/gfx/mgu-gfx-wasm.wasm', [path.join(gfx, 'mgu-gfx-wasm.wasm'), 'application/wasm']]
]);
const renderer = {
    hello: 1, place: 2, show: 3, atlas: 4, ramp: 5, frame: 7, claim: 9, image: 10, dropImage: 11,
    mode: 0x4d520001, grab: 0x4d520002, ready: 0x4d520101, wheel: 0x4d520103,
    legacyReady: 101, touch: 105
};
const names = new Map([['javi_carlauncher_preview', 'launcher'], ['javi_panel_radio_demo', 'panel']]);
const layers = new Map();
const viewers = new Set();
let gesture;
let knob = 0;
let sequence = 0;

function packet(type, payload) {
    const header = Buffer.alloc(8);
    header.writeUInt32LE(type);
    header.writeUInt32LE(payload.length, 4);
    return Buffer.concat([header, payload]);
}

function words(...values) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4));
    return bytes;
}

function publish(response, layer, packets, reset = false) {
    const data = Buffer.concat(packets).toString('base64');
    response.write(`data: ${JSON.stringify({ layer, data, reset })}\n\n`);
}

const daemon = net.createServer((socket) => {
    const layer = { socket, cache: new Map(), claims: [], visible: false, grab: false };
    let bytes = Buffer.alloc(0);
    let pending = [];
    socket.on('data', (chunk) => {
        bytes = Buffer.concat([bytes, chunk]);
        while (bytes.length >= 8) {
            const type = bytes.readUInt32LE();
            const size = bytes.readUInt32LE(4);
            if (size > 24 * 1024 * 1024) return socket.destroy();
            if (bytes.length < 8 + size) return;
            const message = bytes.subarray(0, 8 + size);
            const payload = message.subarray(8);
            bytes = bytes.subarray(8 + size);

            if (type === renderer.hello) {
                layer.name = names.get(payload.toString().split('\0')[0]);
                if (!layer.name || layers.has(layer.name)) return socket.destroy();
                layers.set(layer.name, layer);
                socket.write(packet(renderer.ready, words(1, 1, 3, 0, 0, 0, 0, 0, 0, width, height, 2048, 60000)));
                socket.write(packet(renderer.legacyReady, words(4, width, height, 1)));
            } else if (type === renderer.place) {
                layer.place = {
                    x: payload.readInt32LE(0), y: payload.readInt32LE(4),
                    scale: payload.readFloatLE(16), ox: payload.readFloatLE(20), oy: payload.readFloatLE(24)
                };
            } else if (type === renderer.claim) {
                layer.claims = Array.from({ length: payload.readUInt32LE() }, (_, i) =>
                    [0, 4, 8, 12].map((offset) => payload.readFloatLE(4 + i * 16 + offset)));
                continue;
            } else if (type === renderer.grab) {
                const wasGrabbing = layer.grab;
                layer.grab = !!payload.readUInt32LE();
                if (home && layer.grab && !wasGrabbing) sendController(layer, 0, false, 0);
                continue;
            } else if (type === renderer.show) {
                layer.visible = !!payload.readUInt32LE();
            }

            const key = [renderer.atlas, renderer.ramp, renderer.image].includes(type) ? `${type}:${payload.readUInt32LE()}` : type;
            if (type === renderer.dropImage) layer.cache.delete(`${renderer.image}:${payload.readUInt32LE()}`);
            else layer.cache.set(key, message);
            pending.push(message);
            if (type === renderer.frame || type === renderer.show) {
                for (const viewer of viewers) publish(viewer, layer.name, pending);
                pending = [];
            }
        }
    });
    socket.on('close', () => {
        if (layers.get(layer.name) !== layer) return;
        layers.delete(layer.name);
        for (const viewer of viewers) publish(viewer, layer.name, [], true);
    });
});

function point(layer, x, y) {
    const p = layer.place;
    return [(x - p.x - p.ox) / p.scale, (y - p.y - p.oy) / p.scale];
}

function touch(phase, x, y) {
    if (phase === 1) {
        gesture = ['launcher', 'panel'].map((name) => layers.get(name)).find((layer) => {
            if (!layer?.visible || !layer.place) return false;
            const [px, py] = point(layer, x, y);
            return layer.claims.some(([left, top, w, h]) => px >= left && py >= top && px < left + w && py < top + h);
        });
    }
    if (gesture?.visible && !gesture.socket.destroyed && phase !== 0) {
        const [px, py] = point(gesture, x, y);
        const payload = words(phase, 0, 0);
        payload.writeFloatLE(px, 4);
        payload.writeFloatLE(py, 8);
        gesture.socket.write(packet(renderer.touch, payload));
    }
    if (phase === 0 || phase === 3) gesture = undefined;
}

function wheel(turn, press, tilt) {
    const layer = layers.get(home ? 'launcher' : 'panel');
    if (!layer?.visible || !layer.grab) return;
    sendController(layer, turn, press, tilt);
}

function sendController(layer, turn, press, tilt) {
    knob = (knob + turn) & 0xffff;
    const payload = Buffer.alloc(8);
    payload[0] = ++sequence & 255;
    payload.writeUInt16BE(knob, 1);
    payload[3] = Number(press);
    payload[4] = tilt;
    layer.socket.write(packet(renderer.wheel, payload));
}

const web = http.createServer(async (req, res) => {
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) {
        res.writeHead(403).end();
        return;
    }
    if (req.method === 'GET' && req.url === '/frames') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' });
        res.flushHeaders();
        viewers.add(res);
        res.on('close', () => viewers.delete(res));
        for (const [name, layer] of layers) {
            const setup = [...layer.cache].filter(([key]) => key !== renderer.frame && key !== renderer.show).map(([, data]) => data);
            const draw = [renderer.frame, renderer.show].map((key) => layer.cache.get(key)).filter(Boolean);
            publish(res, name, [...setup, ...draw], true);
        }
        return;
    }
    if (req.method === 'POST' && req.url === '/input') {
        if (req.headers['content-type'] !== 'application/json' || !(Number(req.headers['content-length']) <= 256)) {
            res.writeHead(400).end();
            return;
        }
        try {
            let body = '';
            for await (const chunk of req) body += chunk;
            const input = JSON.parse(body);
            if ([0, 1, 2, 3].includes(input.phase) && Number.isFinite(input.x) && Number.isFinite(input.y)) {
                touch(input.phase, input.x, input.y);
            } else if ([-1, 0, 1].includes(input.turn) && typeof input.press === 'boolean'
                && [undefined, 0, 1, 2, 4, 5, 7, 8, 10, 11].includes(input.tilt)) {
                wheel(input.turn, input.press, input.tilt || 0);
            } else {
                res.writeHead(400).end();
                return;
            }
            res.writeHead(204).end();
        } catch {
            res.writeHead(400).end();
        }
        return;
    }
    const file = req.method === 'GET' && files.get(req.url);
    if (!file) { res.writeHead(404).end(); return; }
    const [filename, mime] = file;
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    if (home && req.url === '/') {
        res.end(fs.readFileSync(filename, 'utf8')
            .replace('<html lang="es">', '<html lang="es" data-drivehub>')
            .replace('CarLauncher · Prueba de panel derecho', 'BMWLauncher · Vista local')
            .replace('CarLauncher · Prueba de panel derecho', 'BMWLauncher · Vista local')
            .replace('Pantalla de CarLauncher', 'Pantalla de BMWLauncher')
            .replace('max-width: 1600px', `max-width: ${width}px`)
            .replace('1600 / 520', `${width} / ${height}`)
            .replace(/width="1600"/g, `width="${width}"`)
            .replace(/<p>Pulsa <strong>Radio<\/strong>.*?<\/p>/,
                '<p>Desliza horizontalmente o usa la rueda para recorrer las tarjetas. Usa ↑/↓ o desliza en vertical para cambiar de vista en Tiempo o de noticia.</p>'));
    } else fs.createReadStream(filename).pipe(res);
});

for (const [filename] of files.values()) fs.accessSync(filename, fs.constants.R_OK);
web.listen(port, '127.0.0.1', () => {
    daemon.listen(pipe, () => {
        if (home) {
            const launcher = fork(path.join(__dirname, 'drivehub.js'), [
                pipe, store, live ? 'live' : 'fixture', process.argv.includes('--telemetry') ? 'telemetry' : ''
            ]);
            launcher.on('exit', (code) => process.exit(code || 1));
            console.log(`BMWLauncher en http://${host}/`);
            return;
        }
        const launcher = fork(path.join(__dirname, 'app.js'), ['launcher', pipe, kit, store]);
        const panel = fork(path.join(__dirname, 'app.js'), ['panel', pipe, kit, store]);
        launcher.on('message', (visible) => { if (panel.connected) panel.send(visible); });
        for (const child of [launcher, panel]) {
            child.on('exit', (code, signal) => {
                console.error(`Un proceso de la prueba ha terminado (${code ?? signal}).`);
                process.exit(1);
            });
        }
        console.log(`Prueba de panel derecho en http://${host}/`);
    });
});
