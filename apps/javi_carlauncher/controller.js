'use strict';

const net = require('net');
const endpoint = '/run/javi-carlab/controller.sock';
const input = 'de.bmw.infotainment.controlelements.FrontCCU';
const steering = 'de.bmw.infotainment.controlelements.SteeringWheelPushButton';
const directions = {
    NORD_KURZ_GEDRUECKT: 1, NORD_LANG_GEDRUECKT: 2,
    OST_KURZ_GEDRUECKT: 4, OST_LANG_GEDRUECKT: 5,
    SUED_KURZ_GEDRUECKT: 7, SUED_LANG_GEDRUECKT: 8,
    WEST_KURZ_GEDRUECKT: 10, WEST_LANG_GEDRUECKT: 11
};
const directionCodes = new Set(Object.values(directions));

function sample(value) {
    if (!value) return null;
    const knob = value.frontRotaryEncoderOperation;
    if (!Number.isInteger(knob) || knob < 0 || knob >= 0xffff) return null;
    const button = value.frontRotaryEncoderPushButton;
    const direction = value.frontRotaryEncoderDeflection;
    const press = [2, 'DREHGEBER_LANG_GEDRUECKT'].includes(button) ? 2
        : [1, 'DREHGEBER_KURZ_GEDRUECKT'].includes(button) ? 1 : 0;
    const tilt = directionCodes.has(direction) ? direction : directions[direction] || 0;
    const frame = Buffer.from([0, 0, press, tilt]);
    frame.writeUInt16BE(knob, 0);
    return frame;
}

function steeringInput(write) {
    let previous;
    return (value, initial) => {
        const button = value && value.operationPushButtonAudioAutomaticTuningSteeringWheel;
        let direction;
        if ([1, 'SUCHLAUF_ABWAERTS_MENUE_SKIP_LINKS'].includes(button)) direction = -1;
        else if ([2, 'SUCHLAUF_AUFWAERTS_MENUE_SKIP_RECHTS'].includes(button)) direction = 1;
        else if ([0, 'KEINE_AKTION'].includes(button)) direction = 0;
        else return;
        if (!initial && previous !== undefined && direction && direction !== previous) {
            write(Buffer.from([0xff, 0xff, 0xfe, direction < 0 ? 1 : 2]));
        }
        previous = direction;
    };
}

function backInput(write) {
    let down;
    return (value, initial) => {
        // Hmi8 maps the seventh FrontCCU field to KEY_BACK.
        const button = value && value.frontOperationButton7;
        const pressed = [1, 2, 'TASTE_KURZ_GEDRUECKT', 'TASTE_LANG_GEDRUECKT'].includes(button);
        if (!pressed && ![0, 4, 'KEINE_BETAETIGUNG', 'TASTE_BERUEHRT__S__ANGENAEHERT__VORHALT'].includes(button)) return;
        if (!initial && pressed && down === false) write(Buffer.from([0xff, 0xff, 0xfe, 3]));
        down = pressed;
    };
}

function observe(builders) {
    let socket;
    let visible = false;
    let retry;
    let latest;
    let stopped = false;
    let wheel, wheelClosing = Promise.resolve();

    function send(frame) {
        if (visible && socket && !socket.connecting && !socket.destroyed && !socket.bufferSize) socket.write(frame);
    }

    function connect() {
        if (stopped || !visible || socket) return;
        const peer = net.createConnection(endpoint);
        socket = peer;
        peer.on('error', () => {});
        peer.on('connect', () => { if (latest) peer.write(latest); });
        peer.on('close', () => {
            if (peer !== socket) return;
            socket = undefined;
            if (visible && !stopped) retry = setTimeout(connect, 1000);
        });
    }

    function receive(value) {
        const frame = sample(value);
        if (!frame || stopped) return;
        latest = frame;
        send(frame);
    }

    let front, closing;
    const subscriptions = [];
    async function watch(attribute, report) {
        let notified = false;
        const token = await attribute.subscribe(value => {
            notified = true;
            if (!stopped) report(value, false);
        });
        subscriptions.push([attribute, token]);
        if (notified || stopped) return;
        Promise.resolve().then(() => attribute.getValue()).then(value => {
            if (!stopped && !notified) report(value, true);
        }).catch(() => {});
    }

    const frontReady = Promise.resolve().then(async () => {
        front = await builders.buildTypedProxy(input, '1');
        if (stopped) return;
        await front.init();
        if (stopped) return;
        await front.waitUntilAvailable();
        if (stopped) return;
        await Promise.all([
            watch(front.statusRotaryEncoderState, receive).catch(() => console.warn('BMWLauncher: rueda FrontCCU no disponible')),
            watch(front.statusPushButtonsState, backInput(send)).catch(() => console.warn('BMWLauncher: Back FrontCCU no disponible'))
        ]);
    }).catch(() => console.warn('BMWLauncher: FrontCCU no disponible'));

    async function connectWheel(job) {
        if (job !== wheel) return;
        job.proxy = await builders.buildAndInitTypedProxy(steering, '1', { timeoutMs: 8000 });
        if (job !== wheel) return;
        job.attribute = job.proxy.statusSearchSwitch1;
        const readSkip = steeringInput(send);
        let notified = false;
        job.subscription = await job.attribute.subscribe((value) => {
            notified = true;
            if (job === wheel) readSkip(value);
        });
        if (job === wheel && !notified) {
            Promise.resolve().then(() => job.attribute.getValue()).then((value) => {
                if (job === wheel && !notified) readSkip(value, true);
            }).catch(() => {});
        }
    }

    function showWheel(on) {
        if (on === Boolean(wheel)) return;
        if (on) {
            const job = {};
            wheel = job;
            job.done = wheelClosing.then(() => connectWheel(job)).catch(() => {
                if (job === wheel) console.warn('BMWLauncher: anterior/siguiente del volante no disponible');
            });
            return;
        }
        const job = wheel;
        wheel = undefined;
        wheelClosing = job.done.then(async () => {
            if (job.subscription !== undefined) {
                await Promise.resolve().then(() => job.attribute.unsubscribe(job.subscription)).catch(() => {});
            }
            if (!job.proxy) return;
            if (typeof job.proxy.shutdown === 'function') await job.proxy.shutdown();
            else if (typeof job.proxy.dispose === 'function') await job.proxy.dispose();
        }).catch(() => {});
    }

    return {
        show(on) {
            visible = on;
            showWheel(on && !stopped);
            clearTimeout(retry);
            if (on) connect();
            else if (socket) { socket.destroy(); socket = undefined; }
        },
        close() {
            if (closing) return closing;
            stopped = true;
            this.show(false);
            const frontClosing = frontReady.then(async () => {
                for (const [attribute, token] of subscriptions) {
                    await Promise.resolve().then(() => attribute.unsubscribe(token)).catch(() => {});
                }
                if (!front) return;
                if (typeof front.shutdown === 'function') await front.shutdown();
                else if (typeof front.dispose === 'function') await front.dispose();
            }).catch(() => {});
            closing = Promise.all([frontClosing, wheelClosing]);
            return closing;
        }
    };
}

module.exports = { observe, sample, steeringInput, backInput };
