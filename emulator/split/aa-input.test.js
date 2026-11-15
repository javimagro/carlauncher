'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createInput, mapFramePoint, touchPdu } = require('../../native/javi-carlab/aa-input');

function fixture(automatic) {
    let time = 0, next = 1, permitted = true, created = 0, closes = 0;
    const timers = new Map(), packets = [], replies = [], handlers = {};
    const input = createInput({ allowed: () => permitted, now: () => time,
        setTimeout(fn, delay) { const id = next++; timers.set(id, { fn, at: time + delay }); return id; },
        clearTimeout(id) { timers.delete(id); },
        createSocket() {
            created++;
            return { on(event, fn) { handlers[event] = fn; }, close() { closes++; },
                send(bytes, port, host, callback) {
                    assert.equal(port, 30567); assert.equal(host, '127.0.0.1');
                    packets.push(bytes);
                    if (automatic) callback(); else replies.push(callback);
                } };
        } });
    function advance(ms) {
        const until = time + ms;
        for (;;) {
            const due = Array.from(timers.entries()).filter(item => item[1].at <= until)
                .sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            time = due[1].at; timers.delete(due[0]); due[1].fn();
        }
        time = until;
    }
    return { input, packets, replies, handlers, advance, timers,
        allow(value) { permitted = value; }, created: () => created, closes: () => closes,
        arm() { input.enable(true); input.setVisible(true); input.setFocus(true); } };
}
const point = { x: 960, y: 540 };
const types = f => f.packets.map(p => p[63] >> 4);

test('AA maps full-frame pixels through the measured MAIN rectangle, excluding black margins', () => {
    assert.deepEqual(mapFramePoint({ x: 0, y: 248 }), { x: 120, y: 0 });
    assert.deepEqual(mapFramePoint(point), { x: 1500, y: 420 });
    assert.deepEqual(mapFramePoint({ x: 960, y: 248 + 450 / 1.4375 }), { x: 1500, y: 450 });
    assert.deepEqual(mapFramePoint({ x: 1919.99, y: 831.99 }), { x: 2879, y: 839 });
    assert.deepEqual(mapFramePoint({ x: 0, y: 260 }), { x: 120, y: 17 });
    [null, { x: NaN, y: 500 }, { x: 1920, y: 500 }, { x: 0, y: 247 },
        { x: 0, y: 832 }, { x: -1, y: 500 }].forEach(p => assert.equal(mapFramePoint(p), null));
});

test('AA builds the observed 112-byte Hmi PDU with one finger and no other payload', () => {
    const bytes = touchPdu(1, 1500, 450);
    assert.equal(bytes.length, 112);
    assert.equal(bytes.subarray(0, 8).toString('hex'), 'b004800200000060');
    assert.equal(bytes[28], 0x80); assert.equal(bytes[53], 1);
    assert.equal(bytes.subarray(54, 56).toString('hex'), '05dc');
    assert.equal(bytes.subarray(60, 64).toString('hex'), '01c23210');
    const cleared = Buffer.from(bytes);
    [0, 1, 2, 3, 7, 28, 53, 54, 55, 60, 61, 62, 63].forEach(n => { cleared[n] = 0; });
    assert.equal(cleared.equals(Buffer.alloc(112)), true);
    assert.throws(() => touchPdu(4, 1500, 450), /range/);
    assert.throws(() => touchPdu(1, 2880, 450), /range/);
});

test('AA input remains inert until explicit owner, visibility, focus and context permission', async () => {
    const f = fixture(true);
    assert.equal(f.input.touch('down', point), false);
    f.input.enable(true); assert.equal(f.input.ready(), false);
    f.input.setVisible(true); assert.equal(f.input.ready(), true);
    assert.equal(f.input.touch('down', point), false); assert.equal(f.created(), 0);
    f.input.setFocus(true); f.allow(false);
    assert.equal(f.input.touch('down', point), false); assert.equal(f.created(), 0);
    f.allow(true); assert.equal(f.input.touch('down', point), true);
    f.allow(false); f.advance(50);
    assert.deepEqual(types(f), [1, 3]);
    assert.equal(f.input.touch('down', point), false);
    await f.input.close(); assert.equal(f.closes(), 1); assert.equal(f.timers.size, 0);
});

test('AA coalesces motion and retains the matching up when UDP completion is delayed', async () => {
    const f = fixture(false); f.arm();
    f.input.touch('down', point);
    for (let n = 0; n < 1000; n++) f.input.touch('move', { x: 900 + n / 10, y: 540 });
    f.input.touch('up', { x: 1100, y: 540 });
    assert.deepEqual(types(f), [1]);
    f.replies.shift()();
    assert.deepEqual(types(f), [1, 3]);
    assert.equal(f.packets[1].readUInt16BE(54), 1701);
    f.replies.shift()(); await f.input.close();
    assert.equal(f.closes(), 1); assert.equal(f.timers.size, 0);
});

test('AA closes its gesture on hide, focus loss, invalid coordinates and silence', async () => {
    for (const cancel of [f => f.input.setVisible(false), f => f.input.setFocus(false),
        f => f.input.enable(false), f => f.input.touch('move', { x: 0, y: 10 }),
        f => f.advance(2000)]) {
        const f = fixture(true); f.arm(); f.input.touch('down', point); cancel(f);
        assert.deepEqual(types(f), [1, 3]);
        f.input.cancel(); assert.deepEqual(types(f), [1, 3]);
        await f.input.close(); assert.equal(f.timers.size, 0);
    }
});

test('AA close drains the owned release once and ignores late callbacks after its deadline', async () => {
    const f = fixture(false); f.arm(); f.input.touch('down', point);
    const closed = f.input.close(); assert.equal(f.input.close(), closed);
    f.advance(250); assert.deepEqual(types(f), [1, 3]);
    f.advance(50); await closed;
    assert.equal(f.closes(), 1); assert.equal(f.timers.size, 0);
    f.replies.forEach(reply => reply());
    f.input.enable(true); assert.equal(f.input.touch('down', point), false);
    assert.deepEqual(types(f), [1, 3]);
});

test('AA transport errors release only its own down and never reopen automatically', async () => {
    const f = fixture(false); f.arm();
    f.input.touch('down', point); f.replies.shift()(new Error('send'));
    assert.deepEqual(types(f), [1, 3]);
    f.replies.shift()(); await f.input.close();
    assert.equal(f.input.ready(), false); assert.equal(f.closes(), 1);
    assert.equal(f.input.touch('move', point), false);
});
