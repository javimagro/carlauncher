'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { makeImage } = require('./vendor/kit_record');
let loading = false, ready = false, archive = null, entries = {}, start = 0;
const images = Object.create(null), listeners = new Set();
// Application-lifetime atlas. Load once asynchronously; first frame need not wait.
function preload(done) {
    if (done) listeners.add(done);
    function finish() { ready = true; const callbacks = Array.from(listeners); listeners.clear(); callbacks.forEach((fn) => fn()); }
    if (ready) { if (done) { listeners.delete(done); setImmediate(done); } }
    else if (!loading) {
        loading = true;
        fs.readFile(path.join(__dirname, 'navigation-icons.rgba.gz'), (error, bytes) => {
            if (error || bytes.length > 512 * 1024) return finish();
            zlib.gunzip(bytes, (err, raw) => {
                try {
                    if (err || raw.length < 4 || raw.length > 8 * 1024 * 1024) return finish();
                    const offset = 4 + raw.readUInt32LE(0);
                    if (offset > 65536 || offset > raw.length) return finish();
                    const index = JSON.parse(raw.toString('utf8', 4, offset));
                    if (Object.keys(index).length > 256 || Object.keys(index).some((key) => {
                        const e = index[key]; return !Array.isArray(e) || e.length !== 3 || e[0] !== 72 || e[1] !== 72 ||
                            !Number.isInteger(e[2]) || e[2] < 0 || offset + e[2] + e[0] * e[1] * 4 > raw.length;
                    })) return finish();
                    archive = raw; start = offset; entries = index;
                } catch (_) { /* The geometric fallback stays usable if an asset is missing. */ }
                finish();
            });
        });
    }
    return () => listeners.delete(done);
}
// Exact reference atlas first; geometry also covers primitives absent from the atlas.
function icon(cv, name, x, y, ink, surface, scale) {
    scale = scale || 1;
    const alias = name === 'stop' ? 'close' : name === 'save-destination' ? 'recent' : name;
    const key = alias + '-' + String(ink).replace('#', '').toUpperCase(), entry = entries[key];
    if (entry && archive) {
        if (!images[key]) images[key] = makeImage(entry[0], entry[1], archive.subarray(start + entry[2], start + entry[2] + entry[0] * entry[1] * 4));
        cv.image(images[key], x - 18 * scale, y - 18 * scale, 36 * scale, 36 * scale); return true;
    }
    const path = (points, width) => cv.polyline(points.map((p) => [x + p[0] * scale, y + p[1] * scale]), (width || 2.5) * scale, ink);
    const ring = (r) => cv.arc(x, y, (r - 2) * scale, r * scale, 0, 360, ink);
    if (name === 'back') path([[8, -11], [-4, 0], [8, 11]]);
    else if (name === 'next') path([[-5, -9], [4, 0], [-5, 9]]);
    else if (name === 'close' || name === 'stop') { path([[-8, -8], [8, 8]]); path([[8, -8], [-8, 8]]); }
    else if (name === 'settings') {
        ring(10); cv.circle(x, y, 4 * scale, surface);
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4; path([[Math.cos(a) * 8, Math.sin(a) * 8], [Math.cos(a) * 15, Math.sin(a) * 15]], 5); }
    } else if (name === 'recent' || name === 'save-destination') path([[-9, 13], [-9, -13], [9, -13], [9, 13], [0, 8], [-9, 13]]);
    else if (name === 'chargers') {
        cv.roundRect(x - 12 * scale, y - 15 * scale, 18 * scale, 30 * scale, 2 * scale, ink);
        cv.polyline([[x - 3 * scale, y - 9 * scale], [x - 8 * scale, y + 1 * scale], [x - 2 * scale, y + 1 * scale], [x - 6 * scale, y + 10 * scale]], 2 * scale, surface);
        path([[11, -8], [11, 11], [7, 11]]); path([[8, -7], [14, -7]]);
    } else if (name === 'battery') {
        cv.strokeRoundRect(x - 14 * scale, y - 7 * scale, 26 * scale, 14 * scale, 2 * scale, 2 * scale, ink); path([[15, -3], [15, 3]], 3);
    } else if (name === 'center') {
        cv.quad([[x, y - 16 * scale], [x + 11 * scale, y + 12 * scale], [x, y + 6 * scale], [x, y - 16 * scale]], ink);
        cv.quad([[x, y - 16 * scale], [x, y + 6 * scale], [x - 11 * scale, y + 12 * scale], [x, y - 16 * scale]], '#7F9FC6');
    } else if (name === 'fit') {
        [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([a, b]) => path([[a * 5, b * 13], [a * 13, b * 13], [a * 13, b * 5]]));
    } else if (name === 'audio') {
        path([[-12, -5], [-6, -5], [1, -11], [1, 11], [-6, 5], [-12, 5], [-12, -5]]);
        cv.arc(x + 2 * scale, y, 7 * scale, 9 * scale, -55, 55, ink); cv.arc(x + 2 * scale, y, 12 * scale, 14 * scale, -55, 55, ink);
    } else if (name === 'assistant') {
        cv.strokeRoundRect(x - 5 * scale, y - 14 * scale, 10 * scale, 20 * scale, 5 * scale, 2 * scale, ink);
        path([[-10, 0], [-10, 5], [-5, 11], [5, 11], [10, 5], [10, 0]]); path([[0, 11], [0, 16]]);
    } else if (name === 'search') { cv.arc(x - 3 * scale, y - 3 * scale, 7 * scale, 9 * scale, 0, 360, ink); path([[4, 4], [12, 12]]); }
    else if (name === 'page-up' || name === 'page-down') { const d = name === 'page-up' ? -1 : 1; path([[-9, -4 * d], [0, 5 * d], [9, -4 * d]]); }
    else if (name === 'zoom-in' || name === 'zoom-out') { path([[-9, 0], [9, 0]]); if (name === 'zoom-in') path([[0, -9], [0, 9]]); }
    else if (name === 'info') { ring(12); path([[0, -1], [0, 8]]); cv.circle(x, y - 6 * scale, 1.5 * scale, ink); }
    else if (name === 'check') path([[-7, 0], [-2, 5], [8, -6]]);
    else if (name === 'clock') { ring(10); path([[0, -6], [0, 0], [5, 3]]); }
    else if (name === 'destination') { path([[-8, 14], [-8, -13], [10, -13], [10, 1], [-8, 1]]); path([[-7, -6], [9, -6]]); path([[1, -12], [1, 0]]); }
    else if (name === 'route-panel') { path([[-10, 12], [-10, -4], [8, -4], [8, -12]]); cv.circle(x - 10 * scale, y + 12 * scale, 3 * scale, ink); path([[3, -8], [8, -13], [13, -8]]); }
    else return false;
    return true;
}
module.exports = { icon, preload };
