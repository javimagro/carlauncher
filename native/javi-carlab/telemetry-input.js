'use strict';

const limit = 16 * 1024;
const { valid: validPreconditioning } = require('./preconditioning-model');

function consume(receive) {
    let partial = '';
    return (chunk) => {
        if (chunk.length > 2 * limit) return false;
        const lines = (partial + chunk.toString('ascii')).split('\n');
        partial = lines.pop();
        if (partial.length > limit) return false;
        for (const line of lines) {
            if (line.length > limit) return false;
            let frame;
            try { frame = JSON.parse(line); }
            catch (_) { return false; }
            if (!frame || frame.version !== 1 || !Array.isArray(frame.records) || frame.records.length > 24) return false;
            if (frame.records.some((row) => !row || typeof row.signal !== 'string' ||
                !['no-sample', 'empty', 'error', 'sample'].includes(row.status))) return false;
            if (frame.preconditioning !== undefined && !validPreconditioning(frame.preconditioning)) return false;
            receive(frame.records, frame.preconditioning);
        }
        return true;
    };
}

module.exports = { consume };
