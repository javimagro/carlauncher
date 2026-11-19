'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, fork } = require('child_process');
const displayProfile = require('./display-profile');
if (process.env.JAVI_DRIVEHUB_TALL === '1' && !displayProfile.selectEnvironment(process.env)) {
    console.warn('BMWLauncher: vista normal hasta reiniciar iDrive y confirmar la configuración táctil');
}
const record = require('./vendor/kit_record.js');
const createSession = require('./drivehub-session.js');
const { listen } = require('./controller-input.js');
const { createLease, createGateProbe, captureReason } = require('./controller-lease.js');
const { createInstallation } = require('./installation.js');
const { parseContext, isLauncher, openContext } = require('./home-context.js');
const { consume: consumeTelemetry } = require('./telemetry-input.js');
const { consume: consumeRadio } = require('./radio-model.js');
const { consume: consumeNavigation } = require('./navigation-model.js');
const { appUid, authorizeApp } = require('./drivehub-uplink.js');
const { width, height } = require('./drivehub-state.js');
const { createCockpit } = require('./cockpit.js');
const { createIntegration: createAndroidAuto } = require('./aa-integration');
const { createFormat } = require('./aa-format');
const { createUnderlay } = require('./aa-underlay');
const { createInput: createAAInput } = require('./aa-input-process');
const { RenderClient } = require('/var/opt/mgu-render/current/mgu_render_client.js');
const nativeAudio = require('./tdt-bmw-bridge');
const bmwAudio = nativeAudio.createBridge((message) => audio.send(message));

const launcherId = 'javi_carlauncher';
const directory = '/var/opt/public/oap';
const dataDirectory = '/var/opt/javi-carlab';
const uplink = '/var/opt/mgu-uplink';
const uplinkLease = '/run/mgu-uplink/lease.json';
const tdtAudio = process.env.JAVI_TDT_PCM || 'plug:smartx:MediaSink_AudioOut_Front_CF_48_COMBINED_STEREO_MULTICHANNEL';
const clusterClient = '/var/opt/cluster-render/current/cluster_render_client.js';
const lease = createLease('/run/javi-carlab/frontccu.lease', (err) => console.warn('BMWLauncher: captura del mando: ' + err.code));
const aaVisibleLease = createLease('/run/javi-carlab/aa-visible.lease', (err) => console.warn('BMWLauncher: sesión AA: ' + err.code));
let aaKnob = false;
let screenConfirmed = false;
let ccuReady = false;
let launcherVisible = false;
let lastContext;
let returnContext;
let homeRequest = false;
let homeDeadline = 0;
let exitFailed = false;
let contextAt = 0;
let gate = false;
let gateCheckedAt = 0;
let gatePending = false;
let stopping = false;
const inspectGate = createGateProbe();
const installation = createInstallation(directory, launcherId);

function releaseController() { lease(false); aaVisibleLease(false); }

function aaRequirement() {
    if (!inspectGate.aaReady()) return 'aa-gate-restart-required';
    return captureReason({ visible: launcherVisible, contextAt, gate, returnContext, exitFailed, ccuReady, screenConfirmed }, Date.now()) === 'Captura activa'
        ? null : 'aa-controls-unavailable';
}

function renewController() {
    if (stopping) return;
    const now = Date.now();
    if (!gatePending && now - gateCheckedAt >= 2000) {
        gatePending = true;
        inspectGate().then((loaded) => { gate = loaded; }, () => { gate = false; }).then(() => {
            gateCheckedAt = Date.now();
            gatePending = false;
        });
    }
    const reason = captureReason({ visible: launcherVisible, contextAt, gate, returnContext, exitFailed, ccuReady, screenConfirmed }, now);
    lease(reason === 'Captura activa', aaKnob && inspectGate.aaReady() && underlay.inputReady() ? 'aa' : 'all');
    aaVisibleLease(underlay.holding() && launcherVisible && screenConfirmed && now - contextAt < 800);
    session.setController(reason);
}

function loadCockpit() {
    if (!fs.existsSync(clusterClient)) return undefined;
    try {
        const { ClusterRender } = require(clusterClient);
        if (typeof ClusterRender === 'function') return createCockpit(ClusterRender, downloadAsApp);
    } catch (_) { console.warn('BMWLauncher: cliente de cockpit no disponible'); }
    return undefined;
}

const gpu = new RenderClient('javi_carlab_frame', console, { kit: record });
const underlay = createUnderlay({
    request(line) { return request(line); },
    allowed: () => aaRequirement() === null,
    beforeOpen: renewController
});
const aaInput = createAAInput({ allowed: () => inspectGate.aaReady() && underlay.inputReady() && launcherVisible && screenConfirmed });
aaInput.enable(true);
const setAAFocus = aaInput.setFocus;
aaInput.setFocus = (on) => { aaKnob = !!on; setAAFocus(on); renewController(); };
const androidAuto = createAndroidAuto(gpu, {
    ffmpeg: path.join(__dirname, 'bin/ffmpeg'),
    capture: path.join(__dirname, 'bin/aa-capture'),
    input: aaInput,
    createFormat: options => createFormat(Object.assign({ displayHeight: height }, options)),
    requirement: aaRequirement,
    createFocus: underlay.acquire
});
const session = createSession(gpu, {
    aa: androidAuto,
    diagnostics: false,
    useOap: true,
    autoStartRadio: true,
    preconditioningCommand(command) { return telemetry.send(JSON.stringify(command) + '\n'); },
    radioCommand(command) { return radio.send(JSON.stringify(command) + '\n'); },
    radioFile: path.join(dataDirectory, 'radio.json'),
    navigationCommand(command) { return navigation.send(JSON.stringify(command) + '\n'); },
    loadCockpit,
    onCaptureScreen(confirmed) {
        screenConfirmed = confirmed;
        if (!confirmed) { underlay.abandon(); releaseController(); }
    },
    onExit() {
        if (!launcherVisible || !returnContext || homeDeadline) return;
        homeRequest = true;
        session.setHome('pending');
    },
    cacheFile: path.join(dataDirectory, 'drivehub-cache.json'),
    navigationFile: path.join(dataDirectory, 'navigation.json'),
    assistantDirectory: path.join(dataDirectory, 'assistant'),
    assistantNetwork: async () => ({ uid: await onlineApp(), uplink: true }),
    assistantAudio: {
        ffmpeg: path.join(__dirname, 'bin/ffmpeg'),
        playback: tdtAudio !== 'off' && { command: path.join(__dirname, 'bin/tdt-pcm'), args: [tdtAudio], handshake: true, bmwFocus: true },
        // Never select a telephone/emergency capture channel by guesswork. Set only after an ENET validation.
        capture: process.env.JAVI_ASSISTANT_CAPTURE_DEVICE && fs.existsSync('/usr/bin/arecord') ? {
            command: '/usr/bin/arecord', args: ['-q', '-D', process.env.JAVI_ASSISTANT_CAPTURE_DEVICE, '-t', 'raw', '-f', 'S16_LE', '-r', '24000', '-c', '1']
        } : null
    },
    tdtDirectory: dataDirectory,
    tdtPlayback: {
        nativeAudio: bmwAudio,
        ffmpeg: process.env.JAVI_TDT_FFMPEG || path.join(__dirname, 'bin/ffmpeg'),
        caFile: path.join(__dirname, 'bin/ca-certificates.crt'),
        proxy: startTdtProxy,
        get: downloadAsApp,
        audio: tdtAudio !== 'off' && { command: path.join(__dirname, 'bin/tdt-pcm'), args: [tdtAudio], handshake: true, bmwFocus: true }
    },
    get: downloadAsApp,
    area(screen, info) {
        const area = displayProfile.selectArea(screen, info, width, height);
        if (!area) console.warn('BMWLauncher requiere el área central ID8 de 2880 x 960 y modo layer');
        return area;
    }
});
const input = listen('/run/javi-carlab/controller.sock', (event) => {
    if (!event.skip) ccuReady = true;
    session.controller(event);
}, (err) => console.warn('BMWLauncher: entrada OAP: ' + err.code), undefined, () => {
    ccuReady = false;
    releaseController();
});
const telemetry = listen('/run/javi-carlab/telemetry.sock', session.telemetry,
    (err) => console.warn('BMWLauncher: telemetría OAP: ' + err.code),
    consumeTelemetry, () => session.telemetry(null));
const navigation = listen('/run/javi-carlab/navigation.sock', session.navigation,
    (err) => console.warn('BMWLauncher: navegación OAP: ' + err.code),
    consumeNavigation, () => session.navigation(null));

const radio = listen('/run/javi-carlab/radio.sock', session.radio,
    (err) => console.warn('BMWLauncher: radio OAP: ' + err.code), consumeRadio, () => session.radio(null));
const audio = listen('/run/javi-carlab/audio.sock', bmwAudio.receive,
    (err) => console.warn('BMWLauncher: audio BMW: ' + err.code), nativeAudio.consume, bmwAudio.disconnected);

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

async function downloadAsApp(url, limit, timeout = 36000) {
    const uid = await onlineApp();
    return new Promise((resolve, reject) => {
        execFile(process.execPath, [path.join(__dirname, 'drivehub-network.js'), url, String(limit)], {
            uid, gid: uid, encoding: 'buffer', maxBuffer: limit + 1024, timeout
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
        worker.once('message', (network) => {
            clearTimeout(timer);
            resolve({ uid, url: network.url, dashUrl: network.dashUrl, close });
        });
    });
}

const request = require('./hmi.js')('/var/opt/iteriodev-overlays/current/hmictl', (err) => {
    console.error(err.message);
    shutdown(1);
});

async function poll() {
    if (stopping) return;
    try {
        const installed = await installation();
        const id = installed.applet;
        const context = parseContext(await request('ctx'));
        if (stopping) return;
        if (!context) throw new Error('BMWLauncher: contexto de iDrive no disponible');
        contextAt = Date.now();
        androidAuto.context(context, id);
        await underlay.poll(context, id);
        if (stopping) return;
        let visible = isLauncher(context, id) || underlay.owns(context);
        if (visible) {
            if (!launcherVisible) returnContext = lastContext && !isLauncher(lastContext, id) ? lastContext : null;
            try {
                const uid = installed.uid;
                if (uid) {
                    input.setOwner(uid);
                    telemetry.setOwner(uid);
                    navigation.setOwner(uid);
                    radio.setOwner(uid);
                    audio.setOwner(uid);
                }
            }
            catch (_) { /* The touch renderer remains available during OAP registration. */ }
            if (homeRequest) {
                homeRequest = false;
                homeDeadline = Date.now() + 1800;
                const result = await request(openContext(returnContext));
                if (stopping) return;
                if (!/^ok(?:\s|$)/.test(result)) failExit();
                else { underlay.abandon(); visible = false; }
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
        renewController();
    } catch (err) {
        if (stopping) return;
        console.warn(err.message);
        launcherVisible = false;
        underlay.abandon();
        lastContext = null;
        homeRequest = false;
        homeDeadline = 0;
        releaseController();
        session.show(false);
    } finally {
        if (!stopping) setTimeout(poll, 400);
    }
}

function failExit() {
    homeDeadline = 0;
    exitFailed = true;
    releaseController();
}

gpu.connect();
poll();
const controllerTimer = setInterval(renewController, 200);

function shutdown(code) {
    if (stopping) return;
    stopping = true;
    clearInterval(controllerTimer);
    releaseController();
    input.close();
    telemetry.close();
    navigation.close();
    radio.close();
    bmwAudio.stop();
    audio.close();
    // Preserve the process long enough to observe format restoration and the
    // capture guardian's retirement. Dropping IPC immediately is not proof.
    const deadline = setTimeout(() => {
        console.warn('BMWLauncher: cierre de Android Auto sin confirmar');
        process.exit(1);
    }, 15000);
    session.close().then(() => {
        clearTimeout(deadline); process.exit(code);
    }, () => {
        clearTimeout(deadline);
        console.warn('BMWLauncher: no se confirmó la retirada de Android Auto');
        process.exit(1);
    });
}
process.once('SIGTERM', () => shutdown(0));
