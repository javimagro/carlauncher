'use strict';

// MGU21 MAIN display only. The owner of this transport restores focus;
// shutdown itself performs no focus change. See ANDROID-AUTO-MGU21.md.
const contract = {
    serviceId: 0xfb73, version: { major: 1, minor: 0 },
    instances: { AndroidAutoProjectedManagerInst1: 128 }, events: {},
    fields: {
        streaming: { schema: { t: 'UInt8' }, getter: { id: 1, reliable: true } }
    },
    methods: {
        videoFocusNotification: { id: 10, reliable: true,
            schema: { t: 'Struct', e: [
                { n: 'newFocusMode', t: 'UInt32', bo: true },
                // The firmware Bool is one byte; retain its catalogue spelling.
                { n: 'unsoliticed', t: 'UInt8' }
            ] },
            retSchema: { t: 'Struct', e: [{ n: 'result', t: 'UInt32', bo: true }] } }
    }
};

function createSession(someip, options) {
    options = options || {};
    const timeout = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0 ?
        Math.min(options.timeoutMs, 4000) : 4000;
    let proxy, connecting, closing, closed = false, ready = false;

    function shutdown() {
        if (!closing && proxy) closing = Promise.resolve().then(() => proxy.shutdown());
        return closing || Promise.resolve();
    }
    function requireReady() {
        if (closed) throw new Error('cancelled');
        if (!ready) throw new Error('not-connected');
    }
    function connect() {
        if (closed) return Promise.reject(new Error('cancelled'));
        if (connecting) return connecting;
        connecting = (async () => {
            let timer;
            try {
                proxy = await someip.buildProxy(contract, 'AndroidAutoProjectedManagerInst1');
                if (closed) throw new Error('cancelled');
                await proxy.init();
                if (closed) throw new Error('cancelled');
                await Promise.race([proxy.waitUntilAvailable(), new Promise((resolve, reject) => {
                    timer = setTimeout(() => reject(new Error('unavailable')), timeout);
                })]);
                if (closed) throw new Error('cancelled');
                ready = true;
            } catch (error) {
                closed = true;
                await shutdown().catch(() => {});
                throw error;
            } finally { clearTimeout(timer); }
        })();
        return connecting;
    }
    async function state() {
        requireReady();
        const value = await proxy.getValue('streaming', 2000);
        requireReady();
        if (value !== 0 && value !== 1) throw new Error('read');
        return { streaming: value === 1 };
    }
    async function focus(mode) {
        requireReady();
        const response = await proxy.callMethod('videoFocusNotification', {
            newFocusMode: mode, unsoliticed: 1
        }, 2500);
        // Do not discard a successful late reply: the supervisor must know
        // that restoration can be required after cancelling an acquisition.
        if (!response || response.result !== 0) {
            const error = new Error('focus');
            if (response && Number.isInteger(response.result)) error.result = response.result;
            throw error;
        }
        return true;
    }
    function close() {
        closed = true;
        ready = false;
        // A pending init owns its cleanup; do not shut down underneath it.
        return connecting ? connecting.catch(() => {}).then(shutdown) : shutdown();
    }
    return { connect, state, focusProjected: () => focus(0), focusNative: () => focus(1), close };
}

module.exports = { createSession };
