'use strict';
const { StringDecoder } = require('string_decoder');
const limit = 1024 * 1024;
const str = (s, n) => typeof s === 'string' && s.length <= n;
function validStation(s) {
    return s && str(s.key, 20) && /^\d+$/.test(s.key) && str(s.memoryKey, 110) && str(s.name, 100) &&
        str(s.title, 100) && str(s.artist, 100) && (!s.text || str(s.text, 180)) &&
        [2, 7, 10].includes(s.list) && Number.isInteger(s.id) && s.id >= 0 && s.id <= 0xffffffff && String(s.id) === s.key &&
        Number.isInteger(s.position) && s.position >= 0 && s.position <= 65535 && ['FM', 'DAB', 'FM/DAB'].includes(s.band) &&
        (s.frequency === null || Number.isFinite(s.frequency) && s.frequency >= 65 && s.frequency <= 108) &&
        ['', 'music', 'sports'].includes(s.category) && typeof s.favorite === 'boolean' && typeof s.receptionLost === 'boolean' &&
        (s.programme === null || s.programme && str(s.programme.name, 100) && [s.programme.start, s.programme.end].every((v) => Number.isInteger(v) && v >= 0 && v < 86400));
}
function validImage(p) {
    return p === null || p && str(p.key, 20) && Number.isInteger(p.serial) &&
        (p.bytes === null || str(p.bytes, 131072) && /^[A-Za-z0-9+/]*={0,2}$/.test(p.bytes));
}
function valid(frame) {
    return frame && frame.version === 1 && Array.isArray(frame.stations) && frame.stations.length <= 1500 && frame.stations.every(validStation) &&
        (frame.current === null || validStation(frame.current)) && typeof frame.active === 'boolean' && typeof frame.sourceKnown === 'boolean' &&
        str(frame.listError, 160) && (frame.clock === undefined || frame.clock === null || Number.isInteger(frame.clock) && frame.clock >= 0 && frame.clock < 86400) && validImage(frame.logo) && validImage(frame.artwork) &&
        (frame.result === null || frame.result && str(frame.result.id, 40) && [true, false, null].includes(frame.result.ok) && str(frame.result.message, 160));
}
function consume(receive) {
    const decoder = new StringDecoder('utf8'); let partial = '';
    return (chunk) => {
        if (chunk.length > limit) return false;
        const lines = (partial + decoder.write(chunk)).split('\n'); partial = lines.pop();
        if (Buffer.byteLength(partial) > limit || lines.length > 8) return false;
        for (const line of lines) {
            if (Buffer.byteLength(line) > limit) return false;
            try { const f = JSON.parse(line); if (!valid(f)) return false; receive(f); } catch (_) { return false; }
        }
        return true;
    };
}
module.exports = { consume, valid, validStation };
