'use strict';

const fs = require('fs');
const { tripSummary, distanceReset } = require('./vehicle-readings');

const sampleInterval = 60000;
const maxSamples = 360;
const bootFile = '/proc/sys/kernel/random/boot_id';

function read(file) {
    return new Promise(resolve => fs.readFile(file, 'utf8', (err, value) => resolve(err ? '' : value)));
}

function createTripHistory(file, boot = () => read(bootFile)) {
    const values = [];
    let bootId, duration, lastAt, saved, latest, lastWriteAt;
    let pending = false, writing, closed = false, restoring = !!file;
    const ready = file ? Promise.all([boot(), read(file)]).then(([id, raw]) => {
        bootId = id.trim();
        if (!bootId || raw.length > 16 * 1024) return;
        const state = JSON.parse(raw);
        if (state && state.boot === bootId && Number.isFinite(state.duration) && state.duration >= 0 &&
            Number.isFinite(state.at) && Array.isArray(state.values) && state.values.length <= maxSamples &&
            state.values.every(Number.isFinite)) saved = state;
    }).catch(() => {}).then(() => { restoring = false; }) : Promise.resolve();

    function persist(now) {
        if (!bootId || !Number.isFinite(duration)) return;
        lastWriteAt = now;
        pending = true;
        if (writing) return;
        const tmp = file + '.tmp';
        function write() {
            pending = false;
            const bytes = JSON.stringify({ boot: bootId, duration, at: lastAt === undefined ? lastWriteAt : lastAt, values,
                latest });
            return new Promise(resolve => {
                fs.writeFile(tmp, bytes, { mode: 0o600 }, error => {
                    if (error) resolve();
                    else fs.rename(tmp, file, () => resolve());
                });
            }).then(() => pending ? write() : undefined);
        }
        writing = write().then(() => { writing = undefined; });
    }

    return {
        ready,
        values,
        sample(vehicle, now) {
            if (closed || restoring) return;
            const summary = tripSummary(vehicle);
            const current = summary.duration;
            if (saved && !Number.isFinite(current)) return;
            let changed = false;
            if (Number.isFinite(current)) {
                if (saved) {
                    if (now >= saved.at && current >= saved.duration && !distanceReset(saved.latest && saved.latest.summary, summary)) {
                        values.splice(0, values.length, ...saved.values);
                        lastAt = saved.at;
                        changed = true;
                    }
                    saved = undefined;
                }
                if (duration === undefined) changed = true;
                else if (current < duration || distanceReset(latest && latest.summary, summary)) {
                    values.length = 0;
                    lastAt = undefined;
                    changed = true;
                }
                duration = current;
                const at = Number.isFinite(vehicle.journeySampledAt) ? Math.min(now, vehicle.journeySampledAt) : now;
                latest = { at, summary };
                if (lastWriteAt === undefined || now < lastWriteAt || now - lastWriteAt >= sampleInterval) changed = true;
            }
            const altitude = vehicle.altitude;
            if (Number.isFinite(altitude) && (!values.length || now < lastAt || now - lastAt >= sampleInterval)) {
                if (values.length === maxSamples) values.shift();
                values.push(altitude);
                lastAt = now;
                changed = true;
            }
            if (changed) persist(now);
        },
        close() {
            closed = true;
            if (latest) persist(Math.max(lastWriteAt || 0, latest.at));
            return writing || Promise.resolve();
        }
    };
}

module.exports = { createTripHistory };
