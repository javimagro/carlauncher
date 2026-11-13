'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createPhotoLoader } = require('./photo-loader');
const { dropImage } = require('./vendor/kit_record');
const { map } = require('./drivehub-state');
const ttl = 7 * 86400000;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
function world(point, zoom) {
    const scale = 256 * Math.pow(2, zoom), lat = clamp(point.latitude, -85.05112878, 85.05112878) * Math.PI / 180;
    return [(point.longitude + 180) / 360 * scale, (1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2 * scale];
}
function geo(x, y, zoom) {
    const scale = 256 * Math.pow(2, zoom);
    return { longitude: ((x / scale * 360) % 360 + 360) % 360 - 180,
        latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * clamp(y / scale, 0, 1)))) * 180 / Math.PI };
}
function project(point, camera) {
    const a = world(point, camera.zoom), c = world(camera, camera.zoom), size = 256 * Math.pow(2, camera.zoom);
    let dx = a[0] - c[0];
    if (dx > size / 2) dx -= size;
    if (dx < -size / 2) dx += size;
    return [map.x + map.w / 2 + dx, map.y + map.h / 2 + a[1] - c[1]];
}
function clipSegment(a, b, box) {
    // Liang-Barsky: keep software previews and GPU coordinates bounded at street zoom.
    let low = 0, high = 1;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const p = [-dx, dx, -dy, dy], q = [a[0] - box.x, box.x + box.w - a[0], a[1] - box.y, box.y + box.h - a[1]];
    for (let i = 0; i < 4; i++) {
        if (!p[i]) { if (q[i] < 0) return null; continue; }
        const r = q[i] / p[i];
        if (p[i] < 0) low = Math.max(low, r); else high = Math.min(high, r);
        if (low > high) return null;
    }
    return [[a[0] + low * dx, a[1] + low * dy], [a[0] + high * dx, a[1] + high * dy]];
}
function visibleTiles(camera) {
    const c = world(camera, camera.zoom), count = Math.pow(2, camera.zoom), out = [];
    const left = c[0] - map.w / 2, top = c[1] - map.h / 2;
    for (let y = Math.floor(top / 256); y <= Math.floor((top + map.h - 1) / 256); y++) {
        for (let x = Math.floor(left / 256); x <= Math.floor((left + map.w - 1) / 256); x++) {
            if (y < 0 || y >= count) continue;
            const wrapped = ((x % count) + count) % count;
            out.push({ key: camera.zoom + '/' + wrapped + '/' + y, x: map.x + x * 256 - left, y: map.y + y * 256 - top });
        }
    }
    return out;
}
function fit(points) {
    if (!points.length) return null;
    const anchor = world(points[0], 0)[0];
    const xy = points.map((p) => { const q = world(p, 0); q[0] = anchor + ((q[0] - anchor + 384) % 256 - 128); return q; });
    const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
    const l = Math.min.apply(null, xs), r = Math.max.apply(null, xs), t = Math.min.apply(null, ys), b = Math.max.apply(null, ys);
    return Object.assign(geo((l + r) / 2, (t + b) / 2, 0), {
        zoom: clamp(Math.floor(Math.log2(Math.min((map.w - 220) / Math.max(r - l, 0.0001), (map.h - 210) / Math.max(b - t, 0.0001)))), 3, 18) });
}
function createMap(options, invalidate) {
    const photos = createPhotoLoader(), memory = new Map(), failed = new Map();
    const template = options.mapTemplate || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
    const provider = crypto.createHash('sha256').update(template).digest('hex').slice(0, 16);
    const directory = options.mapDirectory && path.join(options.mapDirectory, provider);
    const disk = new Map();
    let diskBytes = 0;
    let tiles = [], wanted = new Set(), running = false, closed = false, active = false, issue = '';
    const read = (file) => new Promise((resolve, reject) => fs.readFile(file, (e, v) => e ? reject(e) : resolve(v)));
    const stat = (file) => new Promise((resolve, reject) => fs.stat(file, (e, v) => e ? reject(e) : resolve(v)));
    const ready = directory ? new Promise((resolve) => fs.mkdir(options.mapDirectory, () => fs.mkdir(directory, () => resolve())))
        .then(() => new Promise((resolve) => fs.readdir(directory, (error, names) => resolve(error ? [] : names))))
        .then(async (names) => {
            for (const name of names.filter((f) => /^\d+_\d+_\d+\.png$/.test(f))) {
                try {
                    const file = path.join(directory, name), info = await stat(file);
                    if (Date.now() - info.mtimeMs >= ttl) await new Promise((resolve) => fs.unlink(file, resolve));
                    else { disk.set(name, info.size); diskBytes += info.size; }
                } catch (_) {}
            }
        }) : Promise.resolve();
    async function bytes(key, url, limit) {
        const file = directory && path.join(directory, key.replace(/\//g, '_') + '.png');
        if (file) {
            await ready;
            try { const info = await stat(file); if (info.size <= limit && Date.now() - info.mtimeMs < ttl) return await read(file); } catch (_) {}
            if (disk.size >= 4096 || diskBytes + limit > 128 * 1024 * 1024) throw new Error('MAP_CACHE_FULL');
        }
        if (closed || !active || !wanted.has(key)) throw Object.assign(new Error('IMAGE_CANCELLED'), { code: 'IMAGE_CANCELLED' });
        const value = await options.get(url, limit);
        if (value.length < 24 || value.toString('hex', 0, 8) !== '89504e470d0a1a0a' || value.readUInt32BE(16) !== 256 || value.readUInt32BE(20) !== 256) throw new Error('MAP_TILE_FORMAT');
        if (file && !closed) {
            await new Promise((resolve, reject) => fs.writeFile(file + '.tmp', value, { mode: 0o600 }, (e) => e ? reject(e) : resolve()));
            await new Promise((resolve, reject) => fs.rename(file + '.tmp', file, (e) => e ? reject(e) : resolve()));
            const name = path.basename(file); diskBytes += value.length - (disk.get(name) || 0); disk.set(name, value.length);
        }
        return value;
    }
    function evict() {
        while (memory.size > 40) {
            const key = Array.from(memory.keys()).find((k) => !wanted.has(k));
            if (!key) break;
            dropImage(memory.get(key)); memory.delete(key);
        }
        if (failed.size > 100) failed.clear();
    }
    async function next() {
        if (running || closed || !active || !options.get) return;
        const tile = tiles.find((t) => !memory.has(t.key) && (!failed.has(t.key) || Date.now() - failed.get(t.key) >= 60000));
        if (!tile) return;
        running = true;
        const key = tile.key, parts = key.split('/');
        const url = template.replace('{z}', parts[0]).replace('{x}', parts[1]).replace('{y}', parts[2]);
        try {
            const img = await photos.load(url, (address, limit) => bytes(key, address, Math.min(limit, 512 * 1024)), 256, 256, false,
                () => !closed && active && wanted.has(key));
            if (closed || !active || !wanted.has(key)) dropImage(img);
            else { memory.set(key, img); issue = ''; evict(); invalidate(); }
        } catch (error) { if (error.code !== 'IMAGE_CANCELLED') { failed.set(key, Date.now()); issue = 'Mapa sin conexión'; invalidate(); } }
        finally { running = false; next(); }
    }
    return {
        update(camera, on) { active = !!on; tiles = camera ? visibleTiles(camera) : []; wanted = new Set(tiles.map((t) => t.key)); if (active) next(); },
        draw(cv, night) {
            cv.clip(map.x, map.y, map.w, map.h);
            tiles.forEach((t) => { const img = memory.get(t.key); if (img) cv.image(img, t.x, t.y, 256, 256); });
            if (night) cv.fillRect(map.x, map.y, map.w, map.h, [8, 18, 35, 120]);
            cv.noclip();
        },
        status() { return { issue, ready: tiles.some((t) => memory.has(t.key)), loading: running }; },
        close() { closed = true; photos.close(); memory.forEach(dropImage); memory.clear(); }
    };
}
module.exports = { world, geo, project, visibleTiles, fit, createMap, clipSegment };
