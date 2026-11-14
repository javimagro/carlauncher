'use strict';

const path = require('path'), child = require('child_process');
function connect(config, event, network, dependencies) {
    dependencies = dependencies || {};
    let worker, closed = false, timeout;
    function close() {
        if (closed) return; closed = true; clearTimeout(timeout);
        if (worker) { worker.kill(); const p = worker; const force = setTimeout(() => { if (p.exitCode === null) p.kill('SIGKILL'); }, 500); force.unref(); }
    }
    Promise.resolve().then(() => network ? network() : {}).then((access) => {
        if (closed) return;
        worker = (dependencies.fork || child.fork)(path.join(__dirname, 'assistant-worker.js'), [],
            Object.assign({ silent: true }, Number.isInteger(access.uid) ? { uid: access.uid, gid: access.uid } : {}));
        worker.stdout.resume(); worker.stderr.resume(); // Never relay raw network errors or provider payloads to logs.
        worker.on('error', () => { if (!closed) { event({ type: 'error', code: 'WORKER' }); close(); } });
        worker.on('exit', () => { if (!closed) { event({ type: 'error', code: 'DISCONNECTED' }); close(); } });
        worker.on('message', (message) => { if (!closed) { if (message.type === 'ready') clearTimeout(timeout); event(message); } });
        worker.send({ op: 'start', config, uplink: !!access.uplink });
    }).catch(() => { if (!closed) { event({ type: 'error', code: 'NETWORK' }); close(); } });
    timeout = setTimeout(() => { if (!closed) { event({ type: 'error', code: 'SETUP_TIMEOUT' }); close(); } }, 22000);
    return { close, send(message) { if (!closed && worker && worker.connected) { worker.send(message, (err) => { if (err && !closed) { event({ type: 'error', code: 'NETWORK' }); close(); } }); return true; } return false; } };
}
module.exports = { connect };
