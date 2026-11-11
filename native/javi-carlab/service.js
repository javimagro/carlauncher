'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { fitArea } = require('./layout.js');
const record = require('./vendor/kit_record.js');
const createSession = require('./drivehub-session.js');
const { listen } = require('./controller-input.js');
const { appUid, authorizeApp } = require('./drivehub-uplink.js');
const { width, height } = require('./drivehub-state.js');
const { RenderClient } = require('/var/opt/mgu-render/current/mgu_render_client.js');

const launcherId = 'javi_carlauncher';
const directory = '/var/opt/public/oap';
const dataDirectory = '/var/opt/javi-carlab';
const uplink = '/var/opt/mgu-uplink';
const uplinkLease = '/run/mgu-uplink/lease.json';
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
        if (!info.controller) console.info('BMWLauncher: usando la lectura OAP de FrontCCU');
        return fitArea(info.appArea, width, height);
    }
});
const input = listen('/run/javi-carlab/controller.sock', session.controller,
    (err) => console.warn('BMWLauncher: entrada OAP: ' + err.code));

function networkError(code) {
    return Object.assign(new Error(code), { code });
}

async function downloadAsApp(url, limit) {
    if (!fs.existsSync(uplinkLease)) throw networkError('UPLINK_OFFLINE');
    const uid = appUid(directory, launcherId);
    if (!uid || !authorizeApp({ oap: directory, uplink, id: launcherId, uid })) throw networkError('UPLINK_APP');
    const lease = path.join(directory, 'oap_' + uid, 'data/uplink.json');
    // The upstream uplink rescans app registrations every five seconds.
    for (let i = 0; i < 7 && !fs.existsSync(lease); i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    if (!fs.existsSync(uplinkLease)) throw networkError('UPLINK_OFFLINE');
    if (!fs.existsSync(lease)) throw networkError('UPLINK_APP');

    return new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(__dirname, 'drivehub-network.js'), url, String(limit)], {
            uid, gid: uid, encoding: 'buffer', maxBuffer: limit + 1024, timeout: 36000
        }, (err, bytes, stderr) => {
            if (!err) { resolve(bytes); return; }
            const code = String(stderr).trim();
            reject(networkError(/^[A-Z0-9_]{2,45}$/.test(code) ? code : err.killed ? 'ETIMEDOUT' : 'UPLINK_WORKER'));
        });
    });
}

const request = require('./hmi.js')('/var/opt/iteriodev-overlays/current/hmictl', (err) => {
    console.error(err.message);
    input.close();
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
        const visible = Number.isInteger(id) && (applet === id || applet === id + 3000);
        if (visible) {
            try { input.setOwner(appUid(directory, launcherId)); }
            catch (_) { /* The touch renderer remains available during OAP registration. */ }
        }
        session.show(visible);
    } catch (err) {
        console.warn(err.message);
        session.show(false);
    } finally {
        setTimeout(poll, 400);
    }
}

gpu.connect();
poll();
