'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, fork } = require('child_process');
const { fitArea } = require('./layout.js');
const record = require('./vendor/kit_record.js');
const createSession = require('./drivehub-session.js');
const { listen } = require('./controller-input.js');
const { createLease, gateLoaded } = require('./controller-lease.js');
const { parseContext, isLauncher, openContext } = require('./home-context.js');
const { consume: consumeTelemetry } = require('./telemetry-input.js');
const { appUid, authorizeApp } = require('./drivehub-uplink.js');
const { width, height } = require('./drivehub-state.js');
const { RenderClient } = require('/var/opt/mgu-render/current/mgu_render_client.js');

const launcherId = 'javi_carlauncher';
const directory = '/var/opt/public/oap';
const dataDirectory = '/var/opt/javi-carlab';
const uplink = '/var/opt/mgu-uplink';
const uplinkLease = '/run/mgu-uplink/lease.json';
const tdtAudio = process.env.JAVI_TDT_PCM || 'smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL';
const lease = createLease('/run/javi-carlab/frontccu.lease', (err) => console.warn('BMWLauncher: captura del mando: ' + err.code));
let screenConfirmed = false;
let ccuReady = false;
let launcherVisible = false;
let lastContext;
let returnContext;
let homeRequest = false;
let homeDeadline = 0;
let exitFailed = false;

function releaseController() { lease(false); }

const gpu = new RenderClient('javi_carlab_frame', console, { kit: record });
const session = createSession(gpu, {
    diagnostics: true,
    useOap: true,
    onCaptureScreen(confirmed) {
        screenConfirmed = confirmed;
        if (!confirmed) releaseController();
    },
    onExit() {
        if (!launcherVisible || !returnContext || homeDeadline) return;
        homeRequest = true;
        session.setHome('pending');
    },
    configFile: path.join(dataDirectory, 'drivehub.json'),
    cacheFile: path.join(dataDirectory, 'drivehub-cache.json'),
    tdtDirectory: dataDirectory,
    tdtPlayback: {
        ffmpeg: process.env.JAVI_TDT_FFMPEG || path.join(__dirname, 'bin/ffmpeg'),
        caFile: path.join(__dirname, 'bin/ca-certificates.crt'),
        proxy: startTdtProxy,
        audio: tdtAudio !== 'off' && { command: path.join(__dirname, 'bin/tdt-pcm'), args: [tdtAudio], handshake: true }
    },
    get: downloadAsApp,
    area(screen, info) {
        if (!info || info.modes.indexOf('layer') < 0 || screen.w !== 2880 || screen.h !== 960) {
            console.warn('BMWLauncher requiere la salida ID8 de 2880 x 960 y el modo layer');
            return null;
        }
        return fitArea(info.appArea, width, height);
    }
});
const input = listen('/run/javi-carlab/controller.sock', (event) => {
    ccuReady = true;
    session.controller(event);
}, (err) => console.warn('BMWLauncher: entrada OAP: ' + err.code), undefined, () => {
    ccuReady = false;
    releaseController();
});
const telemetry = listen('/run/javi-carlab/telemetry.sock', session.telemetry,
    (err) => console.warn('BMWLauncher: telemetría OAP: ' + err.code),
    consumeTelemetry, () => session.telemetry(null));

function networkError(code) {
    return Object.assign(new Error(code), { code });
}

async function onlineApp() {
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
    return uid;
}

async function downloadAsApp(url, limit) {
    const uid = await onlineApp();
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

async function startTdtProxy() {
    const uid = await onlineApp();
    return new Promise((resolve, reject) => {
        const worker = fork(path.join(__dirname, 'tdt-proxy.js'), [], { uid, gid: uid, silent: true });
        const close = () => { if (worker.connected) worker.disconnect(); worker.kill(); };
        const timer = setTimeout(() => { close(); reject(networkError('UPLINK_WORKER')); }, 4000);
        worker.on('error', reject);
        worker.once('exit', () => { clearTimeout(timer); reject(networkError('UPLINK_WORKER')); });
        worker.once('message', (url) => {
            clearTimeout(timer);
            resolve({ uid, url, close });
        });
    });
}

const request = require('./hmi.js')('/var/opt/iteriodev-overlays/current/hmictl', (err) => {
    console.error(err.message);
    releaseController();
    input.close();
    telemetry.close();
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
        const context = parseContext(await request('ctx'));
        const visible = isLauncher(context, id);
        if (!context) throw new Error('BMWLauncher: contexto de iDrive no disponible');
        if (visible) {
            if (!launcherVisible) returnContext = lastContext && !isLauncher(lastContext, id) ? lastContext : null;
            try {
                const uid = appUid(directory, launcherId);
                if (uid) {
                    input.setOwner(uid);
                    telemetry.setOwner(uid);
                }
            }
            catch (_) { /* The touch renderer remains available during OAP registration. */ }
            if (homeRequest) {
                homeRequest = false;
                homeDeadline = Date.now() + 1800;
                const result = await request(openContext(returnContext));
                if (!/^ok(?:\s|$)/.test(result)) failExit();
            } else if (homeDeadline && Date.now() >= homeDeadline) failExit();
            session.setHome(exitFailed && !homeDeadline ? 'error' : homeDeadline ? 'pending' : returnContext ? 'ready' : 'unavailable');
        } else {
            if (Number.isInteger(id)) lastContext = context;
            returnContext = null;
            homeRequest = false;
            homeDeadline = 0;
            exitFailed = false;
            releaseController();
        }
        launcherVisible = visible;
        session.show(visible);
        lease(visible && !!returnContext && !exitFailed && ccuReady && screenConfirmed && gateLoaded());
    } catch (err) {
        console.warn(err.message);
        launcherVisible = false;
        lastContext = null;
        homeRequest = false;
        homeDeadline = 0;
        releaseController();
        session.show(false);
    } finally {
        setTimeout(poll, 400);
    }
}

function failExit() {
    homeDeadline = 0;
    exitFailed = true;
    releaseController();
}

gpu.connect();
poll();

process.once('SIGTERM', () => {
    releaseController();
    input.close();
    telemetry.close();
    session.close();
    process.exit(0);
});
