'use strict';

// Minimal, observed MGU21 wire contract. No playlist, volume or routing writes.
const text = (n) => ({ n, t: 'Utf16D', bo: true });
const struct = (e) => ({ t: 'Struct', e });
const error = { n: 'result', t: 'UInt8' };
const contract = {
    serviceId: 0xb0c0, version: { major: 1, minor: 0 },
    instances: { DynamicMediaPlayerMedia: 1 }, events: {},
    fields: {
        focus: { schema: struct([text('token'), text('clientId'), text('clientName'), { n: 'status', t: 'UInt8' }]),
            getter: { id: 2, reliable: true } },
        connection: { schema: { t: 'UInt8' }, getter: { id: 4, reliable: true } },
        player: { schema: { t: 'UInt8' }, getter: { id: 9, reliable: true } }
    },
    methods: {
        acquire: { id: 23, reliable: true,
            schema: struct([text('clientId'), text('clientName'), { n: 'timeOutHeartBeatTimer', t: 'Int32' }]),
            retSchema: struct([error, text('token')]) },
        release: { id: 24, reliable: true, schema: struct([text('token')]), retSchema: struct([error]) }
    }
};
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);
const clientId = (id) => 'BMWLauncher-TDT-' + id;
const owned = (focus, id) => !!focus && focus.clientId === clientId(id) &&
    focus.clientName === 'BMWLauncher' && typeof focus.token === 'string' && focus.token.length > 0;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function createSession(someip, options) {
    options = options || {};
    const wait = options.wait || pause;
    let proxy;
    async function connect() {
        proxy = await someip.buildProxy(contract, 'DynamicMediaPlayerMedia');
        await proxy.init();
        let timer;
        try {
            await Promise.race([proxy.waitUntilAvailable(), new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('unavailable')), 4000);
            })]);
        } finally { clearTimeout(timer); }
    }
    async function state(id) {
        const focus = await proxy.getValue('focus', 2000);
        const connection = await proxy.getValue('connection', 2000);
        if (!focus || !['token', 'clientId', 'clientName'].every((key) => typeof focus[key] === 'string') ||
            !Number.isInteger(focus.status) || focus.status < 0 || focus.status > 3 ||
            !Number.isInteger(connection) || connection < 0 || connection > 4) throw new Error('read');
        const empty = !focus.token && !focus.clientId && !focus.clientName;
        // After reboot MGU21 can restore CONNECTED/HAS_FOCUS with no client
        // and a stopped player. That is an idle selection, not an owned lease.
        const idleSelection = empty && connection === 3 && await proxy.getValue('player', 2000) === 2;
        return { focus, connection, owned: owned(focus, id),
            ready: owned(focus, id) && focus.status === 0 && connection === 3,
            free: empty && (connection === 0 || idleSelection) };
    }
    async function release(id) {
        if (!validId(id)) return false;
        const before = await state(id);
        if (!before.owned) return true; // Never release another client's token.
        // Disconnected/lost attributes can retain the previous owner. Do not
        // reacquire focus to clear them: that would interrupt the new source.
        if (before.focus.status !== 0 && before.connection === 0) return true;
        const response = await proxy.callMethod('release', { token: before.focus.token }, 2500);
        if (!response || response.result !== 0) return false;
        for (let n = 0; n < 10; n++) {
            const after = await state(id);
            if (!after.owned || (after.focus.status !== 0 && after.connection === 0)) return true;
            await wait(100);
        }
        return false;
    }
    async function acquire(id, active) {
        if (!validId(id)) throw new Error('id');
        active = active || (() => true);
        let before;
        for (let n = 0; n < 16; n++) {
            if (!active()) throw new Error('cancelled');
            before = await state(id);
            if (before.free) break;
            // Retuning can overlap the previous session's bounded release.
            await wait(250);
        }
        if (!active()) throw new Error('cancelled');
        if (!before.free) throw new Error('busy');
        const response = await proxy.callMethod('acquire', {
            clientId: clientId(id), clientName: 'BMWLauncher', timeOutHeartBeatTimer: 0
        }, 3000);
        if (!response || response.result !== 0 || !response.token) throw new Error('acquire');
        for (let n = 0; n < 20; n++) {
            if (!active()) { await release(id); throw new Error('cancelled'); }
            const current = await state(id);
            if (!current.owned || current.focus.token !== response.token) throw new Error('lost');
            if (current.ready) return;
            await wait(200);
        }
        await release(id);
        throw new Error('connect');
    }
    return { connect, state, acquire, release,
        close: () => proxy ? proxy.shutdown() : Promise.resolve() };
}
module.exports = { createSession, validId, owned, clientId };
