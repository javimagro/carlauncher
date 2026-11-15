'use strict';

// Offline only. Whitelist numeric counters; never echo URLs, tokens or raw logs.
const fs = require('fs');
const limit = 16 * 1024 * 1024;
const numeric = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function counters(source, names) {
    const result = {};
    if (source && typeof source === 'object') names.forEach((name) => {
        if (numeric(source[name])) result[name] = source[name];
    });
    return result;
}
function analyze(text) {
    if (Buffer.byteLength(text, 'utf8') > limit) throw new Error('TRACE_TOO_LARGE');
    const runs = []; let run, video = null, audio = null, queue = null;
    for (const line of text.split(/\r?\n/)) {
        if (line.length > 65536) continue;
        const match = /\bPCM t=(\d{1,12}) frames=(\d{1,15}) eagain=(\d{1,12}) recover=(\d{1,12})(?:\s|$)/.exec(line);
        if (match) {
            const point = { ms: Number(match[1]), frames: Number(match[2]), waits: Number(match[3]), recoveries: Number(match[4]) };
            if (!run || point.ms < run.last.ms || point.frames < run.last.frames || point.waits < run.last.waits) {
                run = { first: point, last: point, samples: 0 }; runs.push(run);
            }
            run.last = point; run.samples++;
        }
        const at = line.indexOf('{');
        if (at < 0) continue;
        let value; try { value = JSON.parse(line.slice(at)); } catch (_) { continue; }
        if (!value || typeof value !== 'object') continue;
        const stats = value.stats || value;
        if (numeric(stats.presented)) {
            video = counters(stats, ['decoded', 'presented', 'dropped', 'underruns', 'reconnects', 'maxGapMs', 'maxDecodeGapMs', 'queued', 'fps']);
            if (stats.pcmQueue) queue = counters(stats.pcmQueue,
                ['receivedBytes', 'deliveredBytes', 'overflowBytes', 'skippedBytes', 'emptyReads', 'queuedBytes']);
        }
        const sink = stats.audio || value.sink;
        if (sink) audio = counters(sink, ['receivedBytes', 'submittedBytes', 'droppedBytes', 'notReadyBytes',
            'blockedBytes', 'backpressure', 'failures']);
    }
    const native = runs.map((r) => {
        const ms = r.last.ms - r.first.ms, frames = r.last.frames - r.first.frames;
        return { observations: r.samples, measuredMs: ms, acceptedFrames: frames,
            acceptedFramesPerSecond: ms > 0 ? Math.round(frames * 1000 / ms) : null,
            waitCount: r.last.waits - r.first.waits, recoveries: r.last.recoveries - r.first.recoveries };
    });
    const measured = native.filter((r) => r.measuredMs >= 5000);
    return { expectedFramesPerSecond: 48000, native, video, audio, pcmQueue: queue,
        insufficientPcmAcceptance: measured.length ? measured.some((r) => r.acceptedFramesPerSecond < 45600) : null,
        sinkDiscardedPcm: audio && numeric(audio.droppedBytes) ? audio.droppedBytes > 0 : null,
        queueDiscardedPcm: queue && numeric(queue.overflowBytes) && numeric(queue.skippedBytes) ?
            queue.overflowBytes > 0 || queue.skippedBytes > 0 : null,
        limits: ['ALSA acceptance is not audible sound.', 'Frame counters do not detect repeated pictures.',
            'Missing counters are unknown, not zero.', 'Video and queue snapshots describe the last reported decoder.'] };
}
if (require.main === module) {
    try {
        if (process.argv.length < 3) throw new Error('USAGE: node Analizar-Audio-TDT.js TRACE [TRACE...]');
        const reports = process.argv.slice(2).map((file) => {
            if (fs.statSync(file).size > limit) throw new Error('TRACE_TOO_LARGE');
            return analyze(fs.readFileSync(file, 'utf8'));
        });
        console.log(JSON.stringify(reports, null, 2));
    } catch (error) {
        console.error(error.code || (/^(TRACE_|USAGE:)/.test(error.message) ? error.message : 'TRACE_INVALID'));
        process.exitCode = 1;
    }
}
module.exports = { analyze };
