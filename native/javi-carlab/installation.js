'use strict';

const fs = require('fs');
const path = require('path');
const read = (file) => new Promise((resolve, reject) => fs.readFile(file, 'utf8', (err, value) => err ? reject(err) : resolve(value)));

function createInstallation(directory, id) {
    let value = {}, due = 0, pending;
    return async function inspect() {
        if (pending) return pending;
        if (Date.now() < due) return value;
        pending = read(path.join(directory, 'oap_12201/security/uids.txt')).then(async (text) => {
            const row = text.split(/\r?\n/).map((line) => /^(\d+)\s*=\s*(\S+)\s*$/.exec(line.trim()))
                .find((match) => match && match[2] === id && Number(match[1]) > 0 && Number(match[1]) <= 0xffffffff);
            if (!row) throw new Error('OAP_MISSING');
            const uid = Number(row[1]);
            const app = JSON.parse((await read(path.join(directory, 'oap_' + uid, 'rhmiData/application.json'))).replace(/^\uFEFF/, '')).application;
            if (app.name !== id || !Number.isInteger(app.appletId)) throw new Error('OAP_INVALID');
            value = { uid, applet: app.appletId };
            due = Date.now() + 5000;
        }).catch(() => { value = {}; due = Date.now() + 1000; }).then(() => { pending = null; return value; });
        return pending;
    };
}

module.exports = { createInstallation };
