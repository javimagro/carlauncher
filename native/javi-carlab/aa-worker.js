'use strict';

const { createPlayer } = require('./aa-player');
const now = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
let player, parentLease = now(), closing = false;
const send = message => { if (!closing && process.connected) process.send(message, () => {}); };
function close(preserveFrame) {
    if (closing) return;
    closing = true; clearInterval(watch);
    const closed = player ? player.stop(preserveFrame === true) : Promise.resolve();
    function finish(ok, error) {
        const exit = () => process.exit(ok ? 0 : 1);
        if (process.connected) process.send({ type: 'closed', ok, error: error && error.message }, exit);
        else exit();
    }
    closed.then(() => finish(true), error => finish(false, error));
}
const watch = setInterval(() => { if (now() - parentLease > 1500) close(); }, 250);
process.on('message', message => {
    if (closing || !message) return;
    if (message.type === 'lease') parentLease = now();
    else if (message.type === 'stop') close(message.preserveFrame === true);
    else if ((message.type === 'arm' || message.type === 'start') && !player) {
        parentLease = now(); player = createPlayer(message.options, send);
        if (message.type === 'start') player.start(message.session);
        else player.arm(message.session);
    } else if (message.type === 'configure' && player) {
        try {
            if (!player.configure(message.profile)) throw new Error('playback-configured');
        } catch (error) {
            send({ type: 'status', status: 'error', detail: { code: error.message } }); close();
        }
    }
});
process.once('disconnect', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.once('uncaughtException', () => { send({ type: 'status', status: 'error', detail: { code: 'worker' } }); close(); });
