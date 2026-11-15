'use strict';

const { maxFrame } = require('./aa-ts-mux');
const geometry = { x: 0, y: 260, w: 1920, h: 560, videoWidth: 1920, videoHeight: 1080, width: 1536 };
geometry.height = geometry.h * geometry.width / geometry.w;
geometry.decodedWidth = geometry.videoWidth * geometry.width / geometry.w;
geometry.decodedHeight = geometry.videoHeight * geometry.width / geometry.w;
Object.freeze(geometry);

const geometryFields = ['x', 'y', 'w', 'h', 'videoWidth', 'videoHeight', 'width', 'height'];
function validGeometry(value) {
    return !!value && geometryFields.every(key => Number.isInteger(value[key]) && value[key] >= 0 && value[key] % 2 === 0) &&
        value.videoWidth === 1920 && value.videoHeight === 1080 && value.w >= 2 && value.h >= 2 &&
        value.x + value.w <= 1920 && value.y + value.h <= 1080 &&
        value.width >= 2 && value.height >= 2 && value.width <= value.w && value.height <= value.h &&
        value.width * value.h === value.height * value.w;
}
function sameGeometry(a, b) {
    return validGeometry(a) && validGeometry(b) && geometryFields.every(key => a[key] === b[key]);
}
// confirmed is an internal adapter attestation, never a user/config-file option.
// A future bridge must observe and confirm MAIN geometry in the same session
// for each acquisition; an UpdateUiConfig callback alone is not a transaction ACK.
function resolveGeometry(profile, nativeCrop) {
    if (profile === undefined) return geometry;
    if (!profile || profile.display !== 'MAIN' || profile.confirmed !== true) throw new Error('geometry-unconfirmed');
    const value = { x: profile.x, y: profile.y, w: profile.w, h: profile.h,
        videoWidth: profile.videoWidth === undefined ? 1920 : profile.videoWidth,
        videoHeight: profile.videoHeight === undefined ? 1080 : profile.videoHeight,
        width: profile.width === undefined ? profile.w : profile.width,
        height: profile.height === undefined ? profile.h : profile.height,
        decodedWidth: 1920, decodedHeight: 1080 };
    if (!validGeometry(value)) throw new Error('video-geometry');
    if (sameGeometry(value, geometry)) return geometry;
    if (nativeCrop === false) throw new Error('geometry-native-crop-required');
    return Object.freeze(value);
}
function fitGeometry(rect, value) {
    if (!rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite) || rect.w <= 0 || rect.h <= 0 || !validGeometry(value)) return null;
    const scale = Math.min(rect.w / value.w, rect.h / value.h), w = value.w * scale, h = value.h * scale;
    return { x: rect.x + (rect.w - w) / 2, y: rect.y + (rect.h - h) / 2, w, h, scale };
}
function mapInputPoint(rect, x, y, clamp, value) {
    value = value === undefined ? geometry : value;
    const box = fitGeometry(rect, value);
    if (!box || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    if (!clamp && (x < box.x || y < box.y || x >= box.x + box.w || y >= box.y + box.h)) return null;
    const cx = Math.max(0, Math.min(value.w - 1, Math.floor((x - box.x) / box.scale)));
    const cy = Math.max(0, Math.min(value.h - 1, Math.floor((y - box.y) / box.scale)));
    return { x: cx + value.x, y: cy + value.y, contentX: cx, contentY: cy };
}

function cropFrame(input, output) {
    const sourceLuma = geometry.decodedWidth * geometry.decodedHeight, targetLuma = geometry.width * geometry.height;
    if (input.length !== sourceLuma * 3 / 2 || output.length !== targetLuma * 3 / 2) throw new Error('AA_PIXEL_SIZE');
    // The validated crop spans the full encoded width, so each I420 plane is contiguous.
    const top = geometry.y * geometry.decodedHeight / geometry.videoHeight;
    const y = top * geometry.decodedWidth, u = sourceLuma + y / 4, v = sourceLuma * 5 / 4 + y / 4;
    input.copy(output, 0, y, y + targetLuma);
    input.copy(output, targetLuma, u, u + targetLuma / 4);
    input.copy(output, targetLuma * 5 / 4, v, v + targetLuma / 4);
    return output;
}

function createReader(pid, receive) {
    let pending = Buffer.alloc(0), closed = false;
    function push(chunk) {
        if (closed) return;
        if (!Buffer.isBuffer(chunk)) throw new Error('AA_FRAME_TYPE');
        // Consume arbitrary chunk sizes without retaining more than one bounded record.
        let at = 0;
        while (at < chunk.length) {
            let need = pending.length < 64 ? 64 : 64 + pending.readUInt32LE(32);
            const n = Math.min(need - pending.length, chunk.length - at);
            pending = Buffer.concat([pending, chunk.slice(at, at + n)], pending.length + n); at += n;
            if (pending.length < 64) continue;
            const size = pending.readUInt32LE(32);
            if (pending.readUInt32LE(0) !== 0x31464141 || pending.readUInt32LE(4) !== 64 || !size || size > maxFrame ||
                pending.readUInt32LE(36) !== size || pending.readUInt32LE(40) !== 0 || pending.readUInt32LE(48) !== pid ||
                pending.readUInt32LE(56) !== 0 || pending.readUInt32LE(60) > 1) throw new Error('AA_FRAME_HEADER');
            if (pending.length < 64 + size) continue;
            const low = pending.readUInt32LE(8), high = pending.readUInt32LE(12);
            const record = { low, high, timeMs: high * 4294.967296 + low / 1000000,
                flags: pending.readUInt32LE(24), discontinuity: !!pending.readUInt32LE(60), data: pending.slice(64) };
            pending = Buffer.alloc(0);
            receive(record);
            if (closed) return;
        }
    }
    return { push, end() { if (pending.length) throw new Error('AA_FRAME_TRUNCATED'); }, close() { closed = true; pending = Buffer.alloc(0); } };
}

function nals(bytes) {
    const result = [];
    let current = -1, payload = -1;
    for (let i = 0; i < bytes.length - 3;) {
        const prefix = bytes[i] === 0 && bytes[i + 1] === 0 ? (bytes[i + 2] === 1 ? 3 : bytes[i + 2] === 0 && bytes[i + 3] === 1 ? 4 : 0) : 0;
        if (!prefix) { i++; continue; }
        if (current >= 0 && payload < i) result.push({ type: bytes[payload] & 31, bytes: bytes.slice(current, i), payload: bytes.slice(payload, i) });
        current = i; payload = i + prefix; i += prefix;
    }
    if (current >= 0 && payload < bytes.length) result.push({ type: bytes[payload] & 31, bytes: bytes.slice(current), payload: bytes.slice(payload) });
    return result;
}

function spsSize(payload) {
    if (!payload || payload.length < 4 || payload.length > 4096 || (payload[0] & 31) !== 7) throw new Error('AA_SPS');
    const rbsp = [];
    for (let i = 1; i < payload.length; i++) {
        if (i > 2 && payload[i] === 3 && payload[i - 1] === 0 && payload[i - 2] === 0) continue;
        rbsp.push(payload[i]);
    }
    let bit = 0;
    function bits(count) {
        if (count > 32 || bit + count > rbsp.length * 8) throw new Error('AA_SPS_TRUNCATED');
        let value = 0;
        while (count--) { value = value * 2 + ((rbsp[bit >> 3] >> (7 - (bit & 7))) & 1); bit++; }
        return value;
    }
    function ue() { let zeros = 0; while (!bits(1)) if (++zeros > 24) throw new Error('AA_SPS_GOLOMB'); return Math.pow(2, zeros) - 1 + bits(zeros); }
    function se() { const n = ue(); return n & 1 ? (n + 1) / 2 : -n / 2; }
    const profile = bits(8); bits(8); bits(8); ue();
    let chroma = 1, separate = 0;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].indexOf(profile) >= 0) {
        chroma = ue(); if (chroma > 3) throw new Error('AA_SPS_CHROMA');
        if (chroma === 3) separate = bits(1);
        ue(); ue(); bits(1);
        if (bits(1)) for (let i = 0; i < (chroma === 3 ? 12 : 8); i++) if (bits(1)) {
            let last = 8, next = 8;
            for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
        }
    }
    ue(); const order = ue();
    if (order === 0) ue();
    else if (order === 1) { bits(1); se(); se(); const cycle = ue(); if (cycle > 256) throw new Error('AA_SPS_CYCLE'); for (let i = 0; i < cycle; i++) se(); }
    else if (order > 2) throw new Error('AA_SPS_ORDER');
    ue(); bits(1);
    const width = (ue() + 1) * 16, mapUnits = ue() + 1, frame = bits(1);
    if (!frame) bits(1); bits(1);
    let left = 0, right = 0, top = 0, bottom = 0;
    if (bits(1)) { left = ue(); right = ue(); top = ue(); bottom = ue(); }
    const arrayType = separate ? 0 : chroma;
    const unitX = arrayType === 0 || arrayType === 3 ? 1 : 2;
    const unitY = (arrayType === 1 ? 2 : 1) * (2 - frame);
    return { width: width - (left + right) * unitX, height: mapUnits * 16 * (2 - frame) - (top + bottom) * unitY };
}

module.exports = { geometry, validGeometry, sameGeometry, resolveGeometry, fitGeometry, mapInputPoint, cropFrame, createReader, nals, spsSize };
