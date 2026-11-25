'use strict';

const fs = require('fs');
const path = require('path');

function createGateProbe(root = '/proc', options = {}) {
    const io = options.fs || fs;
    const clock = options.now || (() => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; });
    const timeoutMs = options.timeoutMs || 1000, maxAgeMs = options.maxAgeMs || 3000;
    let pid, cached, pending, snapshot = { loaded: false, aa: false, at: -Infinity };
    const read = (file) => new Promise((resolve, reject) => io.readFile(file, 'utf8', (err, value) => err ? reject(err) : resolve(value)));
    const stat = (file) => new Promise((resolve, reject) => io.stat(file, (err, value) => err ? reject(err) : resolve(value)));
    const identity = info => [info.dev, info.ino, info.size, info.mode,
        Number.isFinite(info.mtimeMs) ? info.mtimeMs : info.mtime.getTime(),
        Number.isFinite(info.ctimeMs) ? info.ctimeMs : info.ctime.getTime()].join(':');
    function marker(file, expected) {
        return new Promise(resolve => io.open(file, 'r', (error, fd) => {
            if (error) return resolve(null);
            const finish = value => io.close(fd, () => resolve(value));
            io.fstat(fd, (statError, current) => {
                if (statError || identity(current) !== identity(expected)) return finish(null);
                const data = Buffer.alloc(current.size);
                io.read(fd, data, 0, data.length, 0, (readError, length) => {
                    if (readError || length !== data.length) return finish(null);
                    io.fstat(fd, (lastError, last) => {
                        if (lastError || identity(last) !== identity(current)) return finish(null);
                        finish(data.length >= 64 && data[0] === 0x7f && data[1] === 0x45 && data[2] === 0x4c &&
                            data[3] === 0x46 && data[4] === 2 && data[5] === 1 && data.readUInt16LE(16) === 3 && data.readUInt16LE(18) === 62 &&
                            data.indexOf(Buffer.from('BMWLauncherAAKnobGate1\0', 'ascii')) >= 0);
                    });
                });
            });
        }));
    }
    async function aaCapability(id, maps) {
        const lines = maps.split('\n').filter(line => /\/javi-ccu-gate\.so(?: \(deleted\))?$/.test(line));
        if (!lines.length || lines.some(line => /\(deleted\)$/.test(line))) return false;
        const mappings = lines.map(line => /^[0-9a-f]+-[0-9a-f]+\s+[rwxps-]{4}\s+[0-9a-f]+\s+[0-9a-f]+:[0-9a-f]+\s+(\d+)\s+(.+)$/.exec(line));
        if (mappings.some(value => !value)) return false;
        const inode = Number(mappings[0][1]);
        const file = mappings[0][2].replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
        if (!Number.isSafeInteger(inode) || inode <= 0 || mappings.some(value => Number(value[1]) !== inode || value[2] !== mappings[0][2])) return false;
        try {
            const info = await stat(file);
            if (!info.isFile() || info.ino !== inode || info.size < 64 || info.size > 1024 * 1024) return false;
            const key = id + ':' + file + ':' + identity(info);
            if (cached && cached.key === key) return cached.aa;
            const aa = await marker(file, info);
            if (aa === null) return false;
            cached = { key, aa };
            return aa;
        } catch (_) { return false; }
    }
    async function loaded(id) {
        try {
            if ((await read(path.join(root, id, 'comm'))).trim() !== 'Hmi8') return false;
            pid = id;
            const maps = await read(path.join(root, id, 'maps'));
            const present = /\/javi-ccu-gate\.so$/m.test(maps);
            return present ? { loaded: true, aa: await aaCapability(id, maps) } : null;
        } catch (_) { return false; }
    }
    async function scan() {
        const previous = pid && await loaded(pid);
        if (previous) return previous;
        pid = undefined;
        const entries = await new Promise((resolve) => io.readdir(root, (err, names) => resolve(err ? [] : names)));
        for (const id of entries) if (/^\d+$/.test(id)) { const result = await loaded(id); if (result) return result; }
        cached = undefined;
        return { loaded: false, aa: false };
    }
    const inspect = () => {
        if (pending) return pending.promise;
        const job = { expired: false }; pending = job;
        job.promise = new Promise(resolve => {
            function publish(result) { snapshot = { loaded: result.loaded, aa: result.aa, at: clock() }; resolve(result.loaded); }
            const timer = setTimeout(() => { job.expired = true; publish({ loaded: false, aa: false }); }, timeoutMs);
            function finish(result) {
                clearTimeout(timer);
                if (!job.expired) publish(result);
                if (pending === job) pending = undefined;
            }
            Promise.resolve().then(scan).then(finish, () => finish({ loaded: false, aa: false }));
        });
        return job.promise;
    };
    // A new asynchronous check must not pulse AA off while the last completed
    // result is fresh. A stalled scan expires and cannot later resurrect input.
    inspect.aaReady = () => snapshot.aa && clock() >= snapshot.at && clock() - snapshot.at < maxAgeMs;
    return inspect;
}

const captureReasons = {
    'launcher-hidden': 'Fuera de BMWLauncher',
    'context-unavailable': 'Contexto de iDrive sin actualizar',
    'aa-gate-restart-required': 'Filtro no cargado en Hmi8',
    'return-context-unavailable': 'Esperando destino de retorno',
    'launcher-exit-failed': 'Error al volver a iDrive',
    'controller-sample-unavailable': 'Esperando mando del OAP',
    'touch-layer-unavailable': 'Esperando capa visible y toque'
};

function captureBlocker(state, now) {
    if (!state.visible) return 'launcher-hidden';
    if (now - state.contextAt > 800) return 'context-unavailable';
    if (!state.gate) return 'aa-gate-restart-required';
    if (!state.returnContext) return 'return-context-unavailable';
    if (state.exitFailed) return 'launcher-exit-failed';
    if (!state.ccuReady) return 'controller-sample-unavailable';
    if (!state.screenConfirmed) return 'touch-layer-unavailable';
    return null;
}

function captureReason(state, now) { return captureReasons[captureBlocker(state, now)] || 'Captura activa'; }

function createLease(file, failed) {
    let active = false;
    function remove() {
        try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') failed(err); }
    }
    remove();
    function update(wanted, mode = 'all') {
        if (mode !== 'all' && mode !== 'aa') {
            update(false);
            failed(new Error('Modo de captura FrontCCU no válido'));
            return;
        }
        if (!wanted) {
            if (active) remove();
            active = false;
            return;
        }
        const pending = path.join(path.dirname(file), '.frontccu-' + process.pid);
        try {
            // Empty retains the original all-input gate; 2 bytes permit AA rotary/push.
            fs.writeFileSync(pending, mode === 'aa' ? 'aa' : '', { mode: 0o600, flag: 'wx' });
            fs.renameSync(pending, file);
            active = true;
        } catch (err) {
            try { fs.unlinkSync(pending); } catch (_) { /* It may not have been created. */ }
            failed(err);
            update(false);
        }
    }
    return update;
}

module.exports = { createLease, createGateProbe, captureReason, captureBlocker };
