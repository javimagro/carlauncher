'use strict';

const { createPlayer } = require('./aa-player');
const now = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
let player, parentLease = now(), closing = false;
const send = message => { if (!closing && process.connected) process.send(message, () => {}); };
function close() {
    if (closing) return;
    closing = true; clearInterval(watch);
    if (player) player.stop();
    // Allow native capture to withdraw events; its own lease also expires on EOF.
    setTimeout(() => process.exit(0), 2250);
}
const watch = setInterval(() => { if (now() - parentLease > 1500) close(); }, 250);
process.on('message', message => {
    if (closing || !message) return;
    if (message.type === 'lease') parentLease = now();
    else if (message.type === 'stop') close();
    else if (message.type === 'start' && !player) {
        parentLease = now(); player = createPlayer(message.options, send); player.start(message.session);
    }
});
process.once('disconnect', close);
process.once('SIGTERM', close);
process.once('SIGINT', close);
process.once('uncaughtException', () => { send({ type: 'status', status: 'error', detail: { code: 'worker' } }); close(); });
