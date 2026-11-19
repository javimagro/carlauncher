'use strict';

const fs = require('fs');
const file = '/run/javi-carlab/aa-visible.lease';
const lifetime = 700;

function age(stat, now, maxAge = lifetime) {
    if (!stat || !stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022)) return null;
    const value = now - stat.mtime.getTime();
    return Number.isFinite(value) && value >= 0 && value < maxAge ? value : null;
}

// The root renderer owns this lease. OAP observes it without creating or renewing it.
function observeLease(changed, options) {
    options = options || {};
    const inspect = options.lstat || fs.lstat, clock = options.now || Date.now;
    const maxAge = options.lifetime || lifetime;
    let closed = false, pending = false, visible = false, expiry, revision = 0, refreshing;
    function show(next) { if (!closed && next !== visible) { visible = next; changed(next); } }
    function finishRefresh(value) {
        if (!refreshing) return;
        const job = refreshing; refreshing = undefined; clearTimeout(job.timer); job.done(value);
    }
    function expireRefresh() {
        revision++; clearTimeout(expiry); show(false); finishRefresh(false);
    }
    function poll() {
        if (closed || pending) return;
        pending = true;
        const started = revision;
        inspect(options.file || file, (error, stat) => {
            pending = false;
            if (closed) return;
            // A hide needs a read begun after the transition. An older in-flight
            // result, including one returned after the deadline, cannot revive it.
            if (started !== revision) { if (refreshing) poll(); return; }
            if (refreshing && clock() >= refreshing.until) { expireRefresh(); return; }
            clearTimeout(expiry);
            const elapsed = error ? null : age(stat, clock(), maxAge);
            show(elapsed !== null);
            if (elapsed !== null) expiry = setTimeout(() => { expiry = undefined; show(false); }, maxAge - elapsed);
            finishRefresh(elapsed !== null);
        });
    }
    const timer = setInterval(poll, options.pollMs || 250); poll();
    return {
        refresh(done) {
            if (closed) { done(false); return; }
            finishRefresh(false); revision++;
            const job = { done, until: clock() + 50 }; refreshing = job;
            job.timer = setTimeout(() => {
                if (refreshing !== job) return;
                expireRefresh();
            }, 50);
            poll();
        },
        close() {
            if (closed) return;
            closed = true; clearInterval(timer); clearTimeout(expiry); finishRefresh(false);
        },
        poll
    };
}

module.exports = { observeLease, age, file, lifetime };
