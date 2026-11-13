'use strict';

const fs = require('fs');
const path = require('path');

function createGateProbe(root = '/proc') {
    let pid;
    const read = (file) => new Promise((resolve, reject) => fs.readFile(file, 'utf8', (err, value) => err ? reject(err) : resolve(value)));
    async function loaded(id) {
        try {
            if ((await read(path.join(root, id, 'comm'))).trim() !== 'Hmi8') return false;
            pid = id;
            return /\/javi-ccu-gate\.so$/m.test(await read(path.join(root, id, 'maps')));
        } catch (_) { return false; }
    }
    return async () => {
        if (pid && await loaded(pid)) return true;
        pid = undefined;
        const entries = await new Promise((resolve) => fs.readdir(root, (err, names) => resolve(err ? [] : names)));
        for (const id of entries) if (/^\d+$/.test(id) && await loaded(id)) return true;
        return false;
    };
}

function captureReason(state, now) {
    if (!state.visible) return 'Fuera de BMWLauncher';
    if (now - state.contextAt > 800) return 'Contexto de iDrive sin actualizar';
    if (!state.gate) return 'Filtro no cargado en Hmi8';
    if (!state.returnContext) return 'Esperando destino de retorno';
    if (state.exitFailed) return 'Error al volver a iDrive';
    if (!state.ccuReady) return 'Esperando mando del OAP';
    if (!state.screenConfirmed) return 'Esperando capa visible y toque';
    return 'Captura activa';
}

function createLease(file, failed) {
    let active = false;
    function remove() {
        try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') failed(err); }
    }
    remove();
    function update(wanted) {
        if (!wanted) {
            if (active) remove();
            active = false;
            return;
        }
        const pending = path.join(path.dirname(file), '.frontccu-' + process.pid);
        try {
            fs.writeFileSync(pending, '', { mode: 0o600, flag: 'wx' });
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

module.exports = { createLease, createGateProbe, captureReason };
