'use strict';

const path = require('path');
const { fork } = require('child_process');

function createFocus(applet, changed, options) {
    options = options || {};
    const later = options.setTimeout || setTimeout, cancel = options.clearTimeout || clearTimeout;
    const repeat = options.setInterval || setInterval, cancelRepeat = options.clearInterval || clearInterval;
    let child, timer, stopping = false, settled = false, restoration, terminalError;
    const deadlines = [];
    let resolve, reject;
    const finished = new Promise((yes, no) => { resolve = yes; reject = no; });
    // An unexpected exit may precede the caller's stop(); preserve rejection
    // for that caller without creating an unhandled-rejection window.
    finished.catch(() => {});
    function end(error) {
        if (settled) return;
        settled = true; cancelRepeat(timer); deadlines.forEach(cancel);
        if (error) reject(new Error(error)); else resolve({ restoration });
    }
    function ownSignal(signal) {
        if (child && child.exitCode === null) try { child.kill(signal); } catch (_) {}
    }
    function armDeadline() {
        if (deadlines.length) return;
        deadlines.push(later(() => ownSignal('SIGTERM'), 10000));
        deadlines.push(later(() => ownSignal('SIGKILL'), 13000));
        deadlines.push(later(() => end('focus-stop-timeout'), 14000));
        deadlines.forEach(timer => { if (timer && timer.unref) timer.unref(); });
    }
    function stop() {
        if (stopping || settled) return finished;
        stopping = true; cancelRepeat(timer);
        if (!child) end(terminalError || 'focus-start');
        else {
            armDeadline();
            if (child.connected) try { child.send({ op: 'stop' }, () => {}); } catch (_) { ownSignal('SIGTERM'); }
            else ownSignal('SIGTERM');
        }
        return finished;
    }
    try {
        child = (options.fork || fork)(path.join(__dirname, 'aa-focus-process.js'), [String(applet)],
            { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        const send = () => {
            if (!stopping && !settled && child.connected) try { child.send({ op: 'lease' }, () => {}); } catch (_) { stop(); }
        };
        send(); timer = repeat(send, 250);
        child.on('message', message => {
            if (settled || !message) return;
            if (message.state === 'closed') {
                if (message.safe === true && ['restored', 'native-aa-retained', 'not-acquired'].indexOf(message.restoration) >= 0)
                    restoration = message.restoration;
                else terminalError = 'focus-restore-unconfirmed';
            } else if (message.state === 'error') {
                terminalError = typeof message.code === 'string' ? message.code : 'focus-error';
                if (!stopping) changed(message);
            } else if (!stopping) changed(message);
        });
        child.on('error', () => {
            terminalError = 'focus-start';
            if (!stopping) changed({ state: 'error', code: terminalError });
            if (!child.pid) { stopping = true; end(terminalError); }
            else stop();
        });
        // close follows drained IPC; exit alone can precede the final proof.
        child.once('close', (code) => {
            const unexpected = !stopping;
            stopping = true;
            // An orphan owner can still be restoring after supervisor exit.
            // The lock remains held; never treat bare exit as release proof.
            end(code === 0 && restoration ? undefined : terminalError || 'focus-restore-unconfirmed');
            if (unexpected) changed({ state: 'error', code: terminalError || 'focus-exit' });
        });
    } catch (_) { terminalError = 'focus-start'; stop(); changed({ state: 'error', code: terminalError }); }
    return { stop };
}

module.exports = { createFocus };
