'use strict';

// AA delivers Annex B. The installed FFmpeg demuxes MPEG-TS, not raw H.264.
const maxFrame = 256 * 1024;
function crc(bytes) {
    let value = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        value ^= bytes[i] << 24;
        for (let bit = 0; bit < 8; bit++) value = value & 0x80000000 ? (value << 1) ^ 0x04c11db7 : value << 1;
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0, 0);
    return out;
}

function pts(value) {
    const n = value % 8589934592;
    return Buffer.from([0x21 | ((Math.floor(n / 1073741824) & 7) << 1), Math.floor(n / 4194304) & 255,
        ((Math.floor(n / 32768) & 127) << 1) | 1, Math.floor(n / 128) & 255, ((n & 127) << 1) | 1]);
}

function createMux() {
    let videoCounter = 0, patCounter = 0, pmtCounter = 0, firstTime, lastTime = -Infinity, count = 0;
    function table(pid, bytes, counter) {
        const out = Buffer.alloc(188, 255);
        out[0] = 0x47; out[1] = 0x40 | (pid >> 8); out[2] = pid & 255; out[3] = 0x10 | (counter & 15); out[4] = 0;
        bytes.copy(out, 5); crc(bytes).copy(out, 5 + bytes.length);
        return out;
    }
    return function mux(data, timeMs, flags) {
        if (!Buffer.isBuffer(data) || !data.length || data.length > maxFrame || !Number.isFinite(timeMs) || timeMs < lastTime)
            throw new Error('AA_MUX_INPUT');
        if (firstTime === undefined) firstTime = timeMs;
        lastTime = timeMs;
        const stamp = 90000 + Math.max(0, Math.round((timeMs - firstTime) * 90));
        const parts = [];
        if (count++ % 25 === 0) {
            parts.push(table(0, Buffer.from([0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0]), patCounter++));
            parts.push(table(4096, Buffer.from([2, 0xb0, 18, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 0x1b, 0xe1, 0, 0xf0, 0]), pmtCounter++));
        }
        const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5]), pts(stamp), data]);
        for (let at = 0; at < pes.length;) {
            const first = at === 0, n = Math.min(first ? 176 : 184, pes.length - at);
            const packet = Buffer.alloc(188, 255);
            packet[0] = 0x47; packet[1] = 1 | (first ? 0x40 : 0); packet[2] = 0;
            const adapt = first || n < 184;
            packet[3] = (adapt ? 0x30 : 0x10) | (videoCounter++ & 15);
            if (adapt) {
                packet[4] = 183 - n;
                if (packet[4] > 0) packet[5] = first ? 0x10 | ((flags & 0x10) ? 0x40 : 0) : 0;
                if (first) {
                    const base = stamp % 8589934592;
                    packet[6] = Math.floor(base / 33554432) & 255;
                    packet[7] = Math.floor(base / 131072) & 255;
                    packet[8] = Math.floor(base / 512) & 255;
                    packet[9] = Math.floor(base / 2) & 255;
                    packet[10] = ((base & 1) << 7) | 0x7e; packet[11] = 0;
                }
            }
            pes.copy(packet, 188 - n, at, at + n); at += n; parts.push(packet);
        }
        return Buffer.concat(parts);
    };
}

module.exports = { createMux, crc, maxFrame };
