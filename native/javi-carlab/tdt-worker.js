'use strict';

const { createPlayer } = require('./tdt-player.js');
let player, requestId = 0;
const requests = new Map();
const send = (message) => { if (process.connected) process.send(message, () => {}); };
const get = (url) => new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('MANIFEST_TIMEOUT')); }, 5000);
    requests.set(id, { resolve, reject, timer });
    send({ type: 'manifest', id, url });
});

process.on('message', (message) => {
    if (message.type === 'manifest') {
        const pending = requests.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        requests.delete(message.id);
        if (message.data) pending.resolve(Buffer.from(message.data, 'base64'));
        else pending.reject(new Error('MANIFEST_UNAVAILABLE'));
    } else if (message.type === 'start' && !player) {
        const network = message.network && Object.assign({}, message.network, { close() {} });
        player = createPlayer({ video(id, file) { send({ type: 'video', file }); } }, Object.assign({}, message.options, {
            proxy: () => network, get,
            onStats: (value) => send({ type: 'stats', value }),
            log: { warn() {} }
        }));
        player.ready({ video: true });
        player.start(message.sources, (status, detail) => send({ type: 'status', status, detail }));
    }
});
process.once('disconnect', () => {
    if (player) player.stop();
    requests.forEach((pending) => { clearTimeout(pending.timer); pending.reject(new Error('CLOSED')); });
    requests.clear();
    setTimeout(() => process.exit(0), 600);
});
