'use strict';

const fs = require('fs');
const path = require('path');

function gateLoaded() {
    for (const pid of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(pid)) continue;
        try {
            if (fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim() !== 'Hmi8') continue;
            if (/\/javi-ccu-gate\.so$/m.test(fs.readFileSync('/proc/' + pid + '/maps', 'utf8'))) return true;
        } catch (_) { /* The process may have exited. */ }
    }
    return false;
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

module.exports = { createLease, gateLoaded };
