'use strict';

const fs = require('fs');
const path = require('path');

function appUid(directory, id) {
    const entries = fs.readFileSync(path.join(directory, 'oap_12201/security/uids.txt'), 'utf8');
    for (const line of entries.split(/\r?\n/)) {
        const match = /^(\d+)\s*=\s*(\S+)\s*$/.exec(line.trim());
        const uid = match && Number(match[1]);
        if (match && match[2] === id && uid > 0 && uid <= 0xffffffff) return uid;
    }
    return 0;
}

function authorizeApp({ oap, uplink, id, uid }) {
    const app = path.join(oap, 'oap_' + uid);
    const pkg = JSON.parse(fs.readFileSync(path.join(app, 'source/package.json'), 'utf8').replace(/^\uFEFF/, ''));
    if (pkg.name !== id || pkg.mguInternet !== true) return false;
    const dropIns = path.join(uplink, 'apps.d');
    try { fs.mkdirSync(dropIns, 0o755); }
    catch (err) { if (err.code !== 'EEXIST') throw err; }
    try {
        fs.writeFileSync(path.join(dropIns, id), id + '\n', { flag: 'wx', mode: 0o644 });
    } catch (err) { if (err.code !== 'EEXIST') throw err; }
    return true;
}

module.exports = { appUid, authorizeApp };
