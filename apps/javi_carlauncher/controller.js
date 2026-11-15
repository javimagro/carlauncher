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

    let proxy;
    Promise.resolve().then(() => builders.buildTypedProxy(input, '1'))
        .then((value) => { proxy = value; return proxy.init(); })
        .then(() => proxy.waitUntilAvailable())
        .then(() => proxy.statusRotaryEncoderState.subscribe(receive))
        .then(() => proxy.statusRotaryEncoderState.getValue())
        .then(receive)
        .catch(() => console.warn('BMWLauncher: FrontCCU no disponible'));

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
            if (stopped) return;
            stopped = true;
            this.show(false);
        }
    };
}

module.exports = { observe, sample, steeringInput };
