'use strict';
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');

function createFocus(lost, options) {
    options = options || {};
    const launch = options.fork || fork;
    let child, timer, closed = false, settled = false, pending, rejectStart;
    let finish;
    const ended = new Promise((resolve) => { finish = resolve; });
    function post(op) { if (child && child.connected) child.send({ op }, () => {}); }
    function close() {
        if (!closed) { closed = true; clearInterval(timer); post('stop'); if (rejectStart) rejectStart(new Error('cancelled')); }
        if (!child) finish();
        return ended;
    }
    return {
        start() {
            if (closed) return Promise.reject(new Error('cancelled'));
            if (pending) return pending;
            pending = new Promise((resolve, reject) => {
                rejectStart = reject;
                try {
                    child = launch(path.join(__dirname, 'tdt-focus-process.js'), [crypto.randomBytes(16).toString('hex')], {
                        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
                        env: Object.assign({}, process.env, { VSOMEIP_CONFIGURATION: '/etc/vsomeip' })
                    });
                } catch (_) { finish(); reject(new Error('unavailable')); return; }
                function fail(code) {
                    if (closed) return;
                    clearInterval(timer);
                    if (!settled) { settled = true; reject(new Error(code)); }
                    else lost(code);
                    close();
                }
                child.on('message', (m) => {
                    if (closed || !m) return;
                    if (m.state === 'ready' && !settled) { settled = true; resolve(); }
                    else if (m.state === 'error') fail(['busy', 'lost', 'lease'].includes(m.code) ? m.code : 'unavailable');
                });
                child.on('error', () => { finish(); fail('unavailable'); });
                child.on('exit', () => { finish(); fail('unavailable'); });
                timer = setInterval(() => post('keepalive'), 750);
                post('keepalive');
            });
            return pending;
        }, close
    };
}
module.exports = { createFocus };
