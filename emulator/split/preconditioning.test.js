'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPreconditioning, consumeCommands, service } = require('../../apps/javi_carlauncher/preconditioning-bmw');
const { createPreconditioningUI } = require('../../native/javi-carlab/preconditioning-ui');
const { consume } = require('../../native/javi-carlab/telemetry-input');
const { preconditioningButton: box, home, map, energyBar } = require('../../native/javi-carlab/drivehub-state');
const createSession = require('../../native/javi-carlab/drivehub-session');
const { createNavigationUI } = require('../../native/javi-carlab/navigation-ui');
const { controls } = require('../../native/javi-carlab/navigation-panels');
const { Recorder } = require('../../native/javi-carlab/vendor/kit_record');
const net = require('node:net');
const { once } = require('node:events');
const { report } = require('../../apps/javi_carlauncher/telemetria-mgu');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const sample = (mode = 0, active = false, restriction = 0) => ({ statusFeedbackVWM: mode,
    statusRestrictionsVWM: restriction, statusVWM: active ? 1 : 0 });
async function rig(t, initial = sample()) {
    let now = 1000, tick, notify, value = initial, disposed = 0, unsubscribed = 0;
    const sent = [], proxy = { operationMode: { async setValue(v) { sent.push(v); } },
        statusPredictiveThermalManagement: { async getValue() { return value; }, async subscribe(cb) { notify = cb; return 7; },
            async unsubscribe(id) { assert.equal(id, 7); unsubscribed++; } }, async dispose() { disposed++; } };
    const control = createPreconditioning({ async buildAndInitTypedProxy(name, instance) {
        assert.equal(name, service); assert.equal(instance, '1'); return proxy;
    } }, { now: () => now, every(fn) { tick = fn; return 1; }, cancel() {} });
    t.after(() => control.stop()); await control.ready; await flush();
    return { control, proxy, sent, notify(v) { value = v; notify(v); },
        async advance(ms) { now += ms; tick(); await flush(); }, now: () => now,
        disposed: () => disposed, unsubscribed: () => unsubscribed };
}
const command = (id, enabled) => ({ op: 'precondition', id, enabled });
const status = (extra) => Object.assign({ available: true, pending: false, active: false, mode: 0,
    restriction: 0, requestId: null, result: null }, extra);

test('HV activates manually, waits for BMW feedback and explicitly deactivates on the next tap', async (t) => {
    const r = await rig(t), ui = createPreconditioningUI((c) => { r.control.command(c); return true; }, () => {});
    ui.receive(r.control.snapshot(), r.now()); ui.toggle(r.now()); ui.toggle(r.now()); await flush();
    assert.deepEqual(r.sent, [{ operationModeVWM: 2 }]); assert(ui.state(r.now()).pending);
    ui.receive(r.control.snapshot(), r.now()); assert(!ui.state(r.now()).selected);
    r.notify(sample(1)); ui.receive(r.control.snapshot(), r.now());
    assert(ui.state(r.now()).selected); assert(!ui.state(r.now()).pending);
    ui.toggle(r.now()); await flush(); assert.deepEqual(r.sent[1], { operationModeVWM: 0 });
    r.notify(sample(0, true)); assert(r.control.snapshot().pending, 'active bit must clear too');
    r.notify(sample(0)); ui.receive(r.control.snapshot(), r.now()); assert(!ui.state(r.now()).selected);
});

test('HV preserves auto when enabling manual, and OFF cancels automatic preparation too', async (t) => {
    const r = await rig(t, sample('VWM_AUTO_FEEDBACK', false, 'NO_RESTRICTIONS'));
    await r.control.command(command('manual-auto', true)); assert.deepEqual(r.sent[0], { operationModeVWM: 3 });
    r.notify(sample('VWM_MANUALONAUTO_FEEDBACK', true)); assert.equal(r.control.snapshot().result, 'confirmed');
    await r.control.command(command('off', false)); assert.deepEqual(r.sent[1], { operationModeVWM: 0 });
    r.notify(sample(0)); await r.control.command(command('off', false)); assert.equal(r.sent.length, 2, 'no duplicate writes');
    r.notify(sample(2, true)); await r.control.command(command('off-auto', false)); assert.deepEqual(r.sent[2], { operationModeVWM: 0 });
});

test('HV rejects stale/default/error signals and respects BMW restrictions without blocking OFF', async (t) => {
    const r = await rig(t);
    for (const v of [null, { statusVWM: 63, statusFeedbackVWM: 15, statusRestrictionsVWM: 15 }, sample(14), sample(0, false, 5)]) {
        r.notify(v); await r.control.command(command('bad-' + r.now() + '-' + r.sent.length + '-' + String(v && v.statusFeedbackVWM), true));
        assert.equal(r.sent.length, 0);
    }
    r.notify(sample(1, false, 5)); await r.control.command(command('off-restricted', false));
    assert.deepEqual(r.sent, [{ operationModeVWM: 0 }]); r.notify(sample(0));
    r.proxy.statusPredictiveThermalManagement.getValue = async () => { throw Error('offline'); };
    await r.advance(16000); assert.equal(r.control.snapshot().available, false);
    await r.control.command(command('stale', true)); assert.equal(r.sent.length, 1);
});

test('HV ignores pre-command getters and reports missing confirmation, restriction and setter failure', async (t) => {
    const r = await rig(t); let getter;
    r.proxy.statusPredictiveThermalManagement.getValue = () => new Promise((resolve) => { getter = resolve; });
    await r.advance(2000); await r.control.command(command('a', true)); getter(sample(1)); await flush();
    assert(r.control.snapshot().pending, 'old getter cannot acknowledge a new write');
    await r.advance(13000); assert.equal(r.control.snapshot().result, 'timeout');
    r.notify(sample(0)); await r.control.command(command('b', true)); r.notify(sample(0, false, 4));
    assert.equal(r.control.snapshot().result, 'restricted');
    r.notify(sample(0)); r.proxy.operationMode.setValue = async () => { throw Error('rejected'); };
    await r.control.command(command('c', true)); assert.equal(r.control.snapshot().result, 'error');
    r.control.stop(); await flush(); assert.equal(r.disposed(), 1); assert.equal(r.unsubscribed(), 1);
    assert.equal(r.control.snapshot().available, false);
    await r.control.command(command('closed', true)); assert.equal(r.sent.length, 2);
});

test('closing during proxy creation releases it without reading or writing', async () => {
    let resolve, disposed = 0;
    const c = createPreconditioning({ buildAndInitTypedProxy() { return new Promise((r) => { resolve = r; }); } }, { every() {}, cancel() {} });
    c.stop(); resolve({ dispose() { disposed++; }, operationMode: { setValue() { assert.fail(); } } });
    await c.ready; await flush(); assert.equal(disposed, 1); assert.equal(c.snapshot().available, false);
});

test('a hung HV setter ends the waiting indicator but cannot admit overlapping commands', async (t) => {
    const r = await rig(t); let resolve;
    r.proxy.operationMode.setValue = () => new Promise((done) => { resolve = done; });
    const result = r.control.command(command('hung', true)); await r.advance(13000);
    assert.equal(r.control.snapshot().pending, false); assert.equal(r.control.snapshot().result, 'timeout');
    assert.equal(r.control.snapshot().available, false);
    assert.equal(await r.control.command(command('overlap', false)), false);
    r.control.stop(); resolve(); await result; assert.equal(r.control.snapshot().available, false);
});

test('HV reports only a bounded diagnostic for each setter failure and prefers a vehicle restriction', async (t) => {
    const r = await rig(t), notices = [];
    const ui = createPreconditioningUI((command) => { r.control.command(command); return true; }, () => {}, (notice) => notices.push(notice));
    for (const [error, reason, message] of [
        [Object.assign(Error('private payload'), { code: 'EACCES' }), 'permission', /no tiene permiso/],
        [Error('SOME/IP E_TIMEOUT'), 'no-response', /no respondió/],
        [Object.assign(Error('private payload'), { code: 'ECONNRESET' }), 'service', /conexión/],
        [Error('private payload'), 'unknown', /no ha comunicado la causa/]
    ]) {
        r.notify(sample()); ui.receive(r.control.snapshot(), r.now());
        r.proxy.operationMode.setValue = async () => { throw error; };
        ui.toggle(r.now()); await flush();
        const frame = r.control.snapshot(); ui.receive(frame, r.now());
        assert.equal(frame.result, 'error'); assert.equal(frame.failure, reason);
        assert.match(notices[notices.length - 1], message);
        assert(!JSON.stringify(frame).includes('private payload'));
    }
    r.proxy.operationMode.setValue = async () => { r.notify(sample(0, false, 2)); throw Error('rejected'); };
    r.notify(sample()); await flush();
    await r.control.command(command('restricted-after-write', true));
    assert.equal(r.control.snapshot().result, 'restricted');
    assert.equal(r.control.snapshot().restriction, 2);
});

test('HV command and telemetry parsers are bounded and preserve old telemetry clients', () => {
    const commands = [], receive = consumeCommands((c) => commands.push(c));
    assert(receive(Buffer.from('{"op":"precon'))); assert(receive(Buffer.from('dition","id":"a","enabled":true}\n')));
    assert.equal(commands.length, 1);
    const owners = [];
    const splitCommand = consumeCommands((c, owner) => owners.push(owner));
    assert(splitCommand(Buffer.from('{"op":"precon'), 'old-controls'));
    assert(splitCommand(Buffer.from('dition","id":"a","enabled":true}\n{"op":"precondition","id":"b","enabled":false}\n'), 'new-controls'));
    assert.deepEqual(owners, ['old-controls', 'new-controls']);
    for (const s of ['{"op":"other","id":"a","enabled":true}\n', '{"op":"precondition","enabled":1}\n', 'x'.repeat(2050)])
        assert.equal(consumeCommands(() => assert.fail())(Buffer.from(s)), false);
    const frames = [], read = consume((rows, control) => frames.push([rows, control]));
    assert(read(Buffer.from(JSON.stringify({ version: 1, records: [] }) + '\n')));
    assert(read(Buffer.from(JSON.stringify({ version: 1, records: [], preconditioning: status() }) + '\n')));
    assert.deepEqual(frames, [[[], undefined], [[], status()]]);
    assert.equal(read(Buffer.from(JSON.stringify({ version: 1, records: [], preconditioning: status({ mode: 15 }) }) + '\n')), false);
    assert.equal(read(Buffer.from(JSON.stringify({ version: 1, records: [], preconditioning: status({ failure: 'raw remote error' }) }) + '\n')), false);
});

test('telemetry keeps streaming on hide and only carries HV requests from active controls', { timeout: 5000 }, async (t) => {
    const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let disposed = 0, notify, resolveWrite, requests = 0;
    const written = new Promise((resolve) => { resolveWrite = resolve; });
    const sender = report({ async buildTypedProxy() { throw Error('unused probe'); },
        async buildAndInitTypedProxy(name) {
            if (name !== service) throw Error('unused TASU');
            return { operationMode: { async setValue(value) { requests++; resolveWrite(value); notify(sample(1)); } },
                statusPredictiveThermalManagement: { async getValue() { return sample(); },
                    async subscribe(cb) { notify = cb; return 1; }, async unsubscribe() {} },
                async dispose() { disposed++; } };
        }
    }, { host: '127.0.0.1', port: server.address().port });
    let socket; t.after(() => { sender.show(false); if (socket) socket.destroy(); server.close(); });
    const connected = once(server, 'connection');
    sender.setInteractive(true); sender.show(true); [socket] = await connected;
    let receiveFrame;
    const parse = consume((rows, thermal) => { if (receiveFrame) receiveFrame(thermal); });
    socket.on('data', (data) => assert(parse(data)));
    const frame = await new Promise((resolve) => {
        receiveFrame = thermal => { if (thermal && thermal.available) resolve(thermal); };
    });
    assert.equal(frame.mode, 0);
    socket.write(JSON.stringify(command('socket-tap', true)) + '\n');
    assert.deepEqual(await written, { operationModeVWM: 2 });
    sender.setInteractive(false); await flush(); assert.equal(disposed, 1);
    socket.write(JSON.stringify(command('hidden-tap', false)) + '\n');
    await new Promise(resolve => { receiveFrame = thermal => { if (!thermal) resolve(); }; });
    assert.equal(requests, 1);
    const closed = once(socket, 'close');
    sender.show(false); await closed;
});

test('HV UI never toggles from missing data, handles stale feedback and shows a failed transport', () => {
    const notices = [];
    let sent = 0; const ui = createPreconditioningUI(() => { sent++; return false; }, () => {}, (notice) => notices.push(notice));
    ui.toggle(100); assert.equal(sent, 0);
    ui.receive(status(), 100); ui.toggle(101); assert.equal(sent, 1); assert.match(notices[1], /Sin conexión/);
    ui.toggle(6000); assert.equal(sent, 1); assert.equal(ui.state(6000).available, false);
    ui.reset(); assert.equal(ui.state(6000).selected, false);
});

test('HV touch requires a completed tap, works beside Datos and never writes while hidden', (t) => {
    const sent = [], gpu = new EventEmitter();
    Object.assign(gpu, { place() {}, claim() {}, show() {}, close() {}, frame() {} });
    const session = createSession(gpu, { area: () => ({ scale: 1 }), fixture: { news: [] },
        preconditioningCommand(c) { sent.push(c); return true; } }); t.after(() => session.close());
    gpu.emit('ready', {}, { touch: true }); session.show(true); session.telemetry([], status());
    const x = box.x + 20, y = box.y + 20;
    assert(box.x + box.w < home.x - 120);
    gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'move', x - 90, y); gpu.emit('touch', 'up', x, y);
    gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'cancel', x, y); assert.equal(sent.length, 0);
    gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y); assert.equal(sent[0].enabled, true);
    session.telemetry([], status({ mode: 1, active: true, result: 'confirmed', requestId: sent[0].id }));
    gpu.emit('touch', 'down', home.x - 80, y); gpu.emit('touch', 'up', home.x - 80, y); // Datos
    gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y); assert.equal(sent[1].enabled, false);
    session.show(false); gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y); assert.equal(sent.length, 2);
});

test('assistant and HV share a bottom toast that expires and is cleared when hidden', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
    const gpu = new EventEmitter();
    let labels = [], rectangles = [];
    Object.assign(gpu, { place() {}, claim() {}, show() {}, close() {}, frame() {} });
    const text = Recorder.prototype.text, rect = Recorder.prototype.roundRect, reset = Recorder.prototype.reset;
    t.mock.method(Recorder.prototype, 'reset', function () { labels = []; rectangles = []; return reset.call(this); });
    t.mock.method(Recorder.prototype, 'text', function (value) { labels.push(value); return text.apply(this, arguments); });
    t.mock.method(Recorder.prototype, 'roundRect', function (x, y, w, h, radius, color) {
        rectangles.push({ x, y, w, h, color }); return rect.apply(this, arguments);
    });
    const session = createSession(gpu, { area: () => ({ scale: 1 }), fixture: { news: [] } });
    t.after(() => session.close());
    gpu.emit('ready', {}, { touch: true }); session.show(true);
    await flush();
    const tap = (x, y) => { gpu.emit('touch', 'down', x, y); gpu.emit('touch', 'up', x, y); t.mock.timers.tick(33); };
    const hv = 'Esperando el estado de preacondicionamiento de BMW';
    const assistant = 'Micrófono pendiente de integrar en BMWLauncher. Usa «Escribir».';
    tap(box.x + 20, box.y + 20);
    assert.equal(labels.filter((text) => text === hv).length, 1);
    tap(map.x + 37, map.y + 310);
    assert(!labels.includes(hv));
    assert.equal(labels.filter((text) => text === assistant).length, 1);
    assert(rectangles.some((r) => r.x > map.x && r.x + r.w < map.x + map.w && r.y + r.h === energyBar.y - 24));
    t.mock.timers.tick(4000);
    assert(!labels.includes(assistant));
    tap(box.x + 20, box.y + 20);
    session.show(false); session.show(true); t.mock.timers.tick(33);
    assert(!labels.includes(hv));
});

test('wide navigation headers leave the HV control free in both themes', () => {
    const ui = createNavigationUI({}, () => {});
    try {
        for (const theme of ['day', 'night']) for (const panel of ['search', 'detail', 'settings', 'route']) {
            Object.assign(ui.state, { theme, panel, keyboard: panel === 'search' });
            controls(new Recorder(1960, 520), ui, { theme });
            const close = ui.state.buttons.find((b) => b.id === 'close'); assert(close);
            assert(close.x + close.w <= box.x - 10);
        }
    } finally { ui.close(); }
});
