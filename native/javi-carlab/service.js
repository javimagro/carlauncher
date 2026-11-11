'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fitArea } = require('./layout.js');
const record = require('./vendor/kit_record.js');
const createSession = require('./drivehub-session.js');
const { width, height } = require('./drivehub-state.js');
const { RenderClient } = require('/var/opt/mgu-render/current/mgu_render_client.js');

const launcherId = 'javi_carlauncher';
const directory = '/var/opt/public/oap';
const dataDirectory = '/var/opt/javi-carlab';
const gpu = new RenderClient('javi_carlab_frame', console, { kit: record });
const session = createSession(gpu, {
    configFile: path.join(dataDirectory, 'drivehub.json'),
    cacheFile: path.join(dataDirectory, 'drivehub-cache.json'),
    get: downloadAsApp,
    area(screen, info) {
        if (!info || info.modes.indexOf('layer') < 0 || screen.w !== 2880 || screen.h !== 960) {
            console.warn('BMWLauncher requiere la salida ID8 de 2880 x 960 y el modo layer');
            return null;
        }
        if (!info.controller) console.warn('BMWLauncher: el renderizador ofrece toque, la rueda requiere la puerta FrontCCU');
        return fitArea(info.appArea, width, height);
    }
});

function downloadAsApp(url, limit) {
    return new Promise((resolve, reject) => {
        const uids = fs.readFileSync(path.join(directory, 'oap_12201/security/uids.txt'), 'utf8');
        const entry = uids.split(/\r?\n/).map((line) => line.split('=')).find((parts) =>
            parts.length === 2 && parts[1].trim() === launcherId);
        const uid = Number(entry && entry[0]);
        if (!Number.isInteger(uid) || uid <= 0) {
            reject(new Error('BMWLauncher aún no tiene UID OAP'));
            return;
        }
        execFile(process.execPath, [path.join(__dirname, 'drivehub-network.js'), url, String(limit)], {
            uid, gid: uid, encoding: 'buffer', maxBuffer: limit + 1024, timeout: 36000
        }, (err, bytes) => err ? reject(err) : resolve(bytes));
    });
}

const request = require('./hmi.js')('/var/opt/iteriodev-overlays/current/hmictl', (err) => {
    console.error(err.message);
    session.close();
    process.exit(1);
});

function launcherApplet() {
    for (const name of fs.readdirSync(directory)) {
        if (!/^oap_\d+$/.test(name)) continue;
        try {
            const file = path.join(directory, name, 'rhmiData', 'application.json');
            const app = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).application;
            if (app.name === launcherId && Number.isInteger(app.appletId)) return app.appletId;
        } catch (_) { /* The directory can belong to a non-OAP resource. */ }
    }
    return undefined;
}

async function poll() {
    try {
        const id = launcherApplet();
        const context = /^ok\s+(-?\d+)\s+(-?\d+)/.exec(await request('ctx'));
        const applet = context && Number(context[2]);
        session.show(Number.isInteger(id) && (applet === id || applet === id + 3000));
    } catch (err) {
        console.warn(err.message);
        session.show(false);
    } finally {
        setTimeout(poll, 400);
    }
}

gpu.connect();
poll();
