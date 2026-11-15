'use strict';

const fs = require('fs');
const profile = require('./display-profile');

function atomicWrite(file, text) {
    let mode = 0o644;
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile()) throw new Error('No se modifica un enlace o archivo especial');
        mode = stat.mode & 0o777;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const temp = file + '.bmwlauncher-' + process.pid;
    let fd;
    try {
        fd = fs.openSync(temp, 'wx', mode);
        fs.writeFileSync(fd, text, 'utf8');
        fs.fsyncSync(fd);
        fs.closeSync(fd); fd = undefined;
        fs.renameSync(temp, file);
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
        try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
}

function apply(enable, options) {
    options = options || {};
    const config = options.configFile || profile.configFile;
    const pending = options.pendingFile || profile.pendingFile;
    const previous = profile.readConfig(config);
    const next = profile.editConfig(previous, enable);
    if (next !== previous) {
        // /run is cleared at boot. Never use the higher touch area with the old running renderer.
        atomicWrite(pending, 'Reiniciar iDrive para aplicar el área táctil de BMWLauncher\n');
        atomicWrite(config, next);
    }
    return fs.existsSync(pending)
        ? { reboot: enable ? 'Reinicia iDrive para activar BMWLauncher sin la barra superior' : 'Reinicia iDrive para restaurar el área táctil anterior' }
        : { status: enable ? 'Vista alta preparada' : 'Área táctil restaurada' };
}

if (require.main === module) {
    const action = process.argv[2];
    if (action !== 'activate' && action !== 'deactivate') {
        console.error('Uso: display-profile-install.js activate|deactivate');
        process.exitCode = 1;
    } else {
        try { console.log(JSON.stringify(apply(action === 'activate'))); }
        catch (error) { console.error(error.message); process.exitCode = 1; }
    }
}

module.exports = { apply };
