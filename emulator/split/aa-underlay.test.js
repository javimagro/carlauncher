'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createUnderlay } = require('../../native/javi-carlab/aa-underlay');
const origin = { state: 200, applet: 1000 }, aa = { state: 1, applet: 50 };
function fixture(extra) {
    const commands = [], messages = []; let time = 0;
    const control = createUnderlay(Object.assign({ now: () => time, allowed: () => true,
        request: async command => { commands.push(command); return 'ok'; }
    }, extra));
    return { control, commands, messages, clock: value => { time = value; },
        acquire: () => control.acquire(1000, message => messages.push(message)) };
}

test('AA underlay opens only the observed MAIN context and retains ownership while visible', async () => {
    const f = fixture(); await f.control.poll(origin, 1000); const owner = f.acquire();
    assert.equal(f.control.holding(), true); assert.equal(f.control.inputReady(), false);
    await f.control.poll(origin, 1000); assert.deepEqual(f.commands, ['open 1 50']);
    await f.control.poll(aa, 1000); assert.equal(f.control.owns(aa), true); assert.equal(f.control.inputReady(), true);
    assert.deepEqual(f.messages, [{ state: 'ready' }]);
    const stopped = owner.stop(); assert.equal(f.control.inputReady(), false);
    await f.control.poll(aa, 1000); assert.deepEqual(f.commands, ['open 1 50', 'open 200 1000']);
    await f.control.poll(origin, 1000); await stopped; assert.equal(f.control.holding(), false);
});

test('cancelling before AA context activation writes nothing', async () => {
    const f = fixture(); await f.control.poll(origin, 1000); await f.acquire().stop();
    await f.control.poll(origin, 1000); assert.deepEqual(f.commands, []);
});

test('AA shutdown polls may restore a departing owner but never open a pending one', async () => {
    const f = fixture(); await f.control.poll(origin, 1000);
    const pending = f.acquire();
    await f.control.poll(origin, 1000, true);
    assert.deepEqual(f.commands, []);
    await pending.stop();
    const active = f.acquire();
    await f.control.poll(origin, 1000); await f.control.poll(aa, 1000);
    const closed = active.stop();
    await f.control.poll(aa, 1000, true); await f.control.poll(origin, 1000, true); await closed;
    assert.deepEqual(f.commands, ['open 1 50', 'open 200 1000']);
});

test('AA underlay never restores over a context selected outside the launcher', async () => {
    const f = fixture(); await f.control.poll(origin, 1000); const owner = f.acquire();
    await f.control.poll(origin, 1000); await f.control.poll(aa, 1000);
    await f.control.poll({ state: 5, applet: 42 }, 1000); await owner.stop();
    assert.deepEqual(f.commands, ['open 1 50']); assert.equal(f.control.holding(), false);
    assert.equal(f.messages[1].code, 'aa-context-lost');
});

test('abandoning a layer/home handoff leaves native AA usable without an HMI write', async () => {
    const f = fixture(); await f.control.poll(origin, 1000); const owner = f.acquire();
    await f.control.poll(origin, 1000); await f.control.poll(aa, 1000); f.control.abandon(); await owner.stop();
    await f.control.poll(aa, 1000); assert.deepEqual(f.commands, ['open 1 50']); assert.equal(f.control.owns(aa), false);
});

test('AA underlay input expires independently of cached context', async () => {
    const f = fixture(); await f.control.poll(origin, 1000); const owner = f.acquire();
    await f.control.poll(origin, 1000); await f.control.poll(aa, 1000); f.clock(801);
    assert.equal(f.control.inputReady(), false); f.control.abandon(); await owner.stop();
});

test('late AA open after cancellation is returned only from its own context', async () => {
    let reply; const f = fixture({ request: command => { f.commands.push(command); return new Promise(resolve => { reply = resolve; }); } });
    await f.control.poll(origin, 1000); const owner = f.acquire(); const opening = f.control.poll(origin, 1000);
    const closing = owner.stop(); reply('ok'); await opening;
    const returning = f.control.poll(aa, 1000); reply('ok'); await returning;
    await f.control.poll(origin, 1000); await closing;
    assert.deepEqual(f.commands, ['open 1 50', 'open 200 1000']);
});

test('cancelled AA opening waits through the old context before restoring its late activation', async () => {
    const f = fixture(); await f.control.poll(origin, 1000); const owner = f.acquire();
    await f.control.poll(origin, 1000);
    let ended = false; const closing = owner.stop().then(() => { ended = true; });
    f.clock(100); await f.control.poll(origin, 1000);
    assert.equal(ended, false); assert.equal(f.control.holding(), true);
    f.clock(500); await f.control.poll(aa, 1000);
    assert.deepEqual(f.commands, ['open 1 50', 'open 200 1000']);
    await f.control.poll(origin, 1000); await closing;
    assert.equal(f.control.holding(), false);
});

test('cancelled opening that never confirms AA is reported as uncertain, not restored', async () => {
    const f = fixture(); await f.control.poll(origin, 1000); const owner = f.acquire();
    await f.control.poll(origin, 1000); const closing = owner.stop();
    const rejected = assert.rejects(closing, /aa-context-open-unconfirmed/);
    f.clock(3501); await f.control.poll(origin, 1000); await rejected;
    assert.deepEqual(f.commands, ['open 1 50']); assert.equal(f.control.holding(), false);
});

test('abandoning does not permit a new owner while the previous HMI request remains in flight', async () => {
    let reply; const f = fixture({ request: command => { f.commands.push(command); return new Promise(resolve => { reply = resolve; }); } });
    await f.control.poll(origin, 1000); const old = f.acquire(); const opening = f.control.poll(origin, 1000);
    f.control.abandon(); await old.stop();
    const refused = f.acquire(); assert.equal(f.control.holding(), false);
    assert.equal(f.messages[f.messages.length - 1].code, 'aa-context-unavailable'); await refused.stop();
    reply('ok'); await opening;
    const next = f.acquire(); assert.equal(f.control.holding(), true); await next.stop();
});
