'use strict';

const net = require('net');
const endpoint = '/run/javi-carlab/controller.sock';
const input = 'de.bmw.infotainment.controlelements.FrontCCU';
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

function observe(builders) {
    let socket;
    let visible = false;
    let retry;
    let latest;
    let stopped = false;

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
        if (socket && !socket.connecting && !socket.destroyed && !socket.bufferSize) socket.write(frame);
    }

    let proxy;
    Promise.resolve().then(() => builders.buildTypedProxy(input, '1'))
        .then((value) => { proxy = value; return proxy.init(); })
        .then(() => proxy.waitUntilAvailable())
        .then(() => proxy.statusRotaryEncoderState.subscribe(receive))
        .then(() => proxy.statusRotaryEncoderState.getValue())
        .then(receive)
        .catch(() => console.warn('BMWLauncher: FrontCCU no disponible'));

    return {
        show(on) {
            visible = on;
            clearTimeout(retry);
            if (on) connect();
            else if (socket) { socket.destroy(); socket = undefined; }
        },
        close() {
            stopped = true;
            this.show(false);
        }
    };
}

module.exports = { observe, sample };
