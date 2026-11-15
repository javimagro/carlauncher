'use strict';

// Verified MGU21 MAIN profile. Points belong to the complete 1920x1080
// decoded frame; the visible crop begins at y=260, the protocol margin at 248.
function mapFramePoint(point) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y) ||
        point.x < 0 || point.x >= 1920 || point.y < 248 || point.y >= 832) return null;
    return {
        x: Math.min(2879, Math.round(120 + point.x * 1.4375)),
        y: Math.min(839, Math.round((point.y - 248) * 1.4375))
    };
}

// Hmi8 display PDU, matching the native decoder and the observed two-event tap.
// References: IterioDev/car-apps tools/iteriodev-screencast/screencast.js;
// mgu-store/native/mgu-render/src/touch.c. No SOME/IP service is offered.
function touchPdu(type, x, y) {
    if ([1, 2, 3].indexOf(type) < 0 || !Number.isInteger(x) || !Number.isInteger(y) ||
        x < 120 || x >= 2880 || y < 0 || y >= 840) throw new Error('touch-range');
    const bytes = Buffer.alloc(112), payload = 16;
    bytes.writeUInt32BE(0xb0048002, 0);
    bytes.writeUInt32BE(96, 4);
    bytes[payload + 12] = 0x80;
    bytes[payload + 37] = 1;
    bytes.writeUInt16BE(x, payload + 38);
    bytes.writeUInt16BE(y, payload + 44);
    bytes[payload + 46] = 50;
    bytes[payload + 47] = type << 4;
    return bytes;
}

const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };

function createInput(options) {
    options = options || {};
    const now = options.now || monotonic;
    const later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
    const createSocket = options.createSocket || (() => require('dgram').createSocket('udp4'));
    let enabled = false, visible = false, focused = false, closed = false, closing = false;
    let socket, finger, flight, guard, deadline, done, closingPromise, queue = [];

    function allowed() {
        try { return typeof options.allowed === 'function' && options.allowed() === true; }
        catch (_) { return false; }
    }
    function ready() { return !closed && !closing && enabled && visible && allowed(); }
    function permitted() { return ready() && focused; }
    function dispose() {
        if (closed) return;
        closed = true; enabled = false; finger = undefined; queue = [];
        clear(guard); clear(deadline);
        if (flight) clear(flight.timer);
        flight = undefined;
        if (socket) { try { socket.close(); } catch (_) {} }
        if (done) done();
    }
    function fail() {
        enabled = false;
        // A transport failure ends this instance. Its final up still uses the
        // same socket if the last down reached Hmi8 before the error.
        close();
    }
    function pump() {
        if (closed || flight) return;
        if (!queue.length) { if (closing) dispose(); return; }
        const next = queue.shift();
        if (next.type !== 3 && !permitted()) { cancel(); pump(); return; }
        try {
            if (!socket) { socket = createSocket(); socket.on('error', fail); }
            flight = next;
            next.timer = later(() => {
                if (flight !== next || closed) return;
                flight = undefined;
                if (next.type === 3) dispose(); else fail();
                pump();
            }, 250);
            if (next.type === 1 && finger) finger.attempted = true;
            socket.send(touchPdu(next.type, next.point.x, next.point.y), 30567, '127.0.0.1', (error) => {
                if (flight !== next || closed) return;
                clear(next.timer); flight = undefined;
                if (!error && typeof options.onSent === 'function') {
                    try { options.onSent({ type: next.type, x: next.point.x, y: next.point.y }); } catch (_) {}
                }
                if (error) { if (next.type === 3) dispose(); else fail(); }
                pump();
            });
        } catch (_) {
            if (flight) clear(flight.timer);
            flight = undefined;
            if (next.type === 3) dispose(); else fail();
        }
    }
    function enqueue(type, point) {
        // At most one UDP send and one pending point/release. Motion is coalesced.
        queue = queue.filter(item => item.type !== 2);
        queue.push({ type, point });
        pump();
    }
    function checkGesture() {
        clear(guard); guard = undefined;
        if (!finger) return;
        if (!permitted() || now() - finger.at >= 2000) { cancel(); return; }
        guard = later(checkGesture, 50);
    }
    function cancel() {
        clear(guard); guard = undefined;
        const previous = finger; finger = undefined;
        queue = queue.filter(item => item.type !== 2);
        // Only a release of our own accepted down bypasses a withdrawn lease.
        if (previous && previous.attempted) enqueue(3, previous.point);
    }
    function touch(phase, point) {
        if (phase === 'cancel') { cancel(); return true; }
        if (['down', 'move', 'up'].indexOf(phase) < 0) return false;
        if (!permitted()) { cancel(); return false; }
        const mapped = mapFramePoint(point);
        if (!mapped) { cancel(); return false; }
        if (phase === 'down') {
            // Close the previous gesture; never queue a new down behind its up.
            if (finger) cancel();
            if (flight || queue.length) return false;
            finger = { point: mapped, at: now(), attempted: false };
            enqueue(1, mapped); checkGesture();
            return !closed && !closing;
        }
        if (!finger) return false;
        finger.point = mapped; finger.at = now();
        if (phase === 'up') { finger = undefined; clear(guard); guard = undefined; enqueue(3, mapped); }
        else { enqueue(2, mapped); checkGesture(); }
        return !closed && !closing;
    }
    function close() {
        if (closingPromise) return closingPromise;
        closingPromise = new Promise(resolve => { done = resolve; });
        if (closed) { done(); return closingPromise; }
        closing = true; enabled = false;
        deadline = later(dispose, 300);
        cancel(); pump();
        return closingPromise;
    }
    return {
        ready, touch, cancel, close,
        enable(value) { enabled = value === true; if (!enabled) cancel(); },
        setVisible(value) { visible = value === true; if (!visible) cancel(); },
        setFocus(value) { focused = value === true; if (!focused) cancel(); },
        // Controller events belong to Hmi8's existing MAIN route.
        controller() { return false; }
    };
}

module.exports = { createInput, mapFramePoint, touchPdu };
