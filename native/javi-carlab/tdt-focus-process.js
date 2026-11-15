'use strict';

// Two independent processes: owner + supervisor. The latter is connected
// before acquisition and can release the exact client after owner death.
const { fork } = require('child_process');
const { createSession, validId } = require('./tdt-focus-session');
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const send = (value) => { if (process.connected) process.send(value, () => {}); };

async function run(id, owner) {
    if (!validId(id) || !process.send) throw new Error('arguments');
    const session = createSession(require('/usr/lib/someip.node'));
    let stopping = false, child, childClosed = false, cleanOwner = false;
    let lastLease = Date.now(), polling = false, timer, pending;
    let connected = false;
    async function finish(reason) {
        if (stopping) return;
        stopping = true; clearInterval(timer);
        if (reason) send({ state: 'error', code: reason });
        // Last resort for an unavailable firmware service; never leave a child
        // repeatedly acquiring. The supervisor still performs its own release.
        const deadline = setTimeout(() => process.exit(2), owner ? 13000 : 22000);
        let released = false;
        try {
            if (owner) {
                if (pending) await pending.catch(() => {});
                if (connected) released = await session.release(id);
            } else {
                if (child && !childClosed) {
                    if (child.connected) child.send({ op: 'stop' }, () => {});
                    for (let n = 0; n < 30 && !childClosed; n++) await pause(100);
                    if (!childClosed) child.kill('SIGKILL');
                }
                // Cover a late acquisition reply after an owner crash, using
                // the client id allocated before that owner existed.
                const until = Date.now() + (child && !cleanOwner ? 7000 : 0);
                do {
                    if (connected) released = await session.release(id);
                    if (Date.now() >= until) break;
                    await pause(300);
                } while (true);
            }
        } catch (_) { released = false; }
        try { await session.close(); } catch (_) {}
        send({ state: 'closed', released });
        clearTimeout(deadline);
        setTimeout(() => process.exit(released || !connected ? 0 : 2), 50);
    }
    process.on('disconnect', () => finish());
    process.on('SIGTERM', () => finish());
    process.on('SIGINT', () => finish());
    process.on('message', (m) => {
        if (!m) return;
        if (m.op === 'stop') finish();
        else if (m.op === 'keepalive') lastLease = Date.now();
    });
    try {
        await session.connect(); connected = true;
        if (stopping) { await session.close(); return; }
        if (owner) {
            pending = session.acquire(id, () => !stopping);
            await pending;
            if (stopping) return;
            send({ state: 'ready' });
            timer = setInterval(async () => {
                if (polling || stopping) return;
                polling = true;
                try { if (!(await session.state(id)).ready) finish('lost'); }
                catch (_) { finish('read'); }
                finally { polling = false; }
            }, 750);
        } else {
            child = fork(__filename, [id, 'owner'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
            child.on('message', (m) => {
                if (!m) return;
                if (m.state === 'closed') cleanOwner = m.released === true;
                else if (!stopping) send(m);
            });
            child.on('error', () => finish('unavailable'));
            child.on('exit', () => { childClosed = true; finish(stopping ? undefined : 'lost'); });
            timer = setInterval(() => {
                if (Date.now() - lastLease > 3500) finish('lease');
            }, 250);
        }
    } catch (error) { finish(['busy', 'lost', 'connect', 'acquire'].includes(error.message) ? error.message : 'unavailable'); }
}
if (require.main === module) run(process.argv[2], process.argv[3] === 'owner').catch(() => process.exit(1));
