'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createUnderlay } = require('../../native/javi-carlab/aa-underlay');
const homeContext = require('../../native/javi-carlab/home-context');

test('service shutdown keeps its AA context owner after the renderer reports hidden', async () => {
    const origin = 'ok 200 1000 0 0 0', aa = 'ok 1 50 0 0 0';
    const commands = [], exits = [], timers = new Map();
    let context = origin, focus, terminate, owner;
    const noop = () => {};
    const turn = () => new Promise(resolve => setImmediate(resolve));
    const tick = async () => {
        assert.ok(timers.has(400), 'service still polls HMI');
        const poll = timers.get(400); timers.delete(400); poll(); await turn();
    };
    const modules = {
        path,
        './tdt-bmw-bridge': { createBridge: () => ({ stop: noop }) },
        './controller-lease.js': { createLease: () => noop, createGateProbe: () => async () => false, captureReason: () => '' },
        './installation.js': { createInstallation: () => async () => ({ applet: 1000 }) },
        './home-context.js': homeContext,
        '/var/opt/mgu-render/current/mgu_render_client.js': { RenderClient: class { connect() {} } },
        './aa-underlay': { createUnderlay: options => createUnderlay(Object.assign({}, options, { allowed: () => true })) },
        './aa-input-process': { createInput: () => ({ enable: noop, setFocus: noop }) },
        './aa-integration': { createIntegration: (gpu, options) => { focus = options.createFocus; return { context: noop }; } },
        './drivehub-session.js': (gpu, options) => ({ show: noop, setHome: noop, setController: noop,
            close() { options.onCaptureScreen(false); return owner.stop(); } }),
        './controller-input.js': { listen: () => ({ close: noop }) },
        './hmi.js': () => async command => {
            commands.push(command);
            if (command === 'ctx') return context;
            context = command === 'open 1 50' ? aa : origin;
            return 'ok';
        }
    };
    const file = path.resolve(__dirname, '../../native/javi-carlab/service.js');
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        __dirname: path.dirname(file), require: name => modules[name] || {}, console,
        process: { env: {}, once: (signal, callback) => { assert.equal(signal, 'SIGTERM'); terminate = callback; }, exit: code => exits.push(code) },
        setTimeout: (fn, ms) => { timers.set(ms, fn); return ms; }, clearTimeout: ms => timers.delete(ms),
        setInterval: noop, clearInterval: noop
    }, { filename: file });
    await turn();
    owner = focus(1000, noop); await tick(); await tick();
    terminate(); await turn();
    assert.deepEqual(exits, []);
    await tick(); await tick();
    assert.deepEqual(commands.filter(command => command !== 'ctx'), ['open 1 50', 'open 200 1000']);
    assert.deepEqual(exits, [0]);
    assert.equal(timers.size, 0);
});
