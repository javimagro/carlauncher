'use strict';

// Owns one MAIN format acquisition and its restoration. The integration injects
// this owner explicitly; importing the module never connects or changes format.
const base = '/tmp/bmwlauncher-aa-margins-13006';
const marker = 'javi-aa-format/1.0.0';
const statusLimit = 768; // Matches the v3 native server's bounded line buffer.
const profiles = Object.freeze({
    normal: Object.freeze({ display: 'MAIN', confirmed: true, x: 312, y: 250, w: 1296, h: 580, width: 1296, height: 580 }),
    alto: Object.freeze({ display: 'MAIN', confirmed: true, x: 376, y: 250, w: 1168, h: 580, width: 1168, height: 580 })
});
const monotonic = () => { const t = process.hrtime(); return t[0] * 1000 + t[1] / 1000000; };
const fault = code => { const e = new Error(code); e.code = code; return e; };
const validPid = pid => Number.isInteger(pid) && pid > 1 && pid <= 2147483647;
const validNs = value => typeof value === 'string' && /^(0|[1-9]\d{0,19})$/.test(value) &&
    (value.length < 20 || value <= '18446744073709551615');
const baseline = value => value.baseline === 1 && value.insets.length === 4 &&
    value.insets.every((n, i) => n === [248, 248, 0, 0][i]);
function statIdentity(pid, text) {
    if (!validPid(pid) || typeof text !== 'string' || text.length > 4096) throw fault('process-identity');
    const end = text.lastIndexOf(')'), fields = text.slice(end + 2).trim().split(/\s+/);
    if (text.slice(0, end + 1) !== pid + ' (aapd)' || !/^[A-Z]$/.test(fields[0]) ||
        fields[0] === 'Z' || fields[0] === 'X' || !/^\d{1,24}$/.test(fields[19] || '')) throw fault('process-identity');
    return Object.freeze({ pid, starttime: fields[19] });
}
function equalIdentity(a, b) { return !!a && !!b && a.pid === b.pid && a.starttime === b.starttime; }
const idle = value => value.phase === 'off' && !value.baseline && !value.dirty && !value.uncertain;
function validStatus(s) {
    return !!s && s.v === 3 && s.marker === marker && s.rearm === 1 && s.leaseMs === 1000 && s.ackMs === 2000 &&
        typeof s.starttime === 'string' && /^\d{1,24}$/.test(s.starttime) &&
        validPid(s.pid) && Number.isSafeInteger(s.epoch) && s.epoch >= 0 &&
        Number.isSafeInteger(s.generation) && s.generation >= 0 &&
        (idle(s) || (s.epoch > 0 && s.generation > 0)) && Number.isSafeInteger(s.updateSeq) && s.updateSeq >= 0 &&
        validNs(s.setStartedNs) &&
        ['hello', 'ok', 'accepted', 'rejected', 'state'].indexOf(s.result) >= 0 &&
        ['off', 'waiting-baseline', 'ready', 'applying', 'active', 'restoring', 'done', 'blocked'].indexOf(s.phase) >= 0 &&
        ['writes', 'baseline', 'dirty', 'uncertain'].every(k => s[k] === 0 || s[k] === 1) &&
        Array.isArray(s.insets) && s.insets.length === 4 && s.insets.every(n => Number.isInteger(n) && n >= 0 && n <= 4096);
}

function createFormat(options) {
    options = options || {};
    // Internal panel geometry only, never a user-editable margins configuration.
    if (options.displayHeight !== 520 && options.displayHeight !== 572) throw fault('format-display-height');
    const selected = options.displayHeight === 520 ? 'normal' : 'alto', profile = profiles[selected];
    const fs = options.fs || require('fs'), connect = options.connect || (p => require('net').createConnection(p));
    const now = options.now || monotonic, later = options.setTimeout || setTimeout, clear = options.clearTimeout || clearTimeout;
    const repeat = options.setInterval || setInterval, clearRepeat = options.clearInterval || clearInterval;
    const uid = options.getuid || (() => typeof process.getuid === 'function' ? process.getuid() : -1);
    let identity, epoch, generation, updateSeq = -1, paths, socket, last, lastAt = -Infinity, begun = false, closing = false, ended = false;
    let connected = false, lost = false, prepared = false, setSent = false, setAccepted = false, setRejected = false;
    let rearmFrom, rearmSent = false, rearmAccepted = false, setStartedNs;
    let restoreSent = false, restored = false, noChange = false, readBuffer = '', startedAt, acquireUntil, lastLeaseAt;
    let watch, acquireTimer, closeTimer, endTimer, writeTimer, writing, queued, expected = [];
    let acquisition, profileRequest, closingResolve, closingReject, closePromise, failure;
    function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
    function read(method, file, extra) {
        return new Promise((resolve, reject) => {
            const callback = (error, value) => error ? reject(fault('private-path-read')) : resolve(value);
            if (extra === undefined) fs[method](file, callback); else fs[method](file, extra, callback);
        });
    }
    function readIdentity(pid) { return read('readFile', '/proc/' + pid + '/stat', 'utf8').then(text => statIdentity(pid, text)); }
    function socketPath(value) { return base + '/' + value.pid + '-' + value.starttime + '/control'; }
    async function verifyPaths(value, previous) {
        const names = ['/tmp', base, base + '/' + value.pid + '-' + value.starttime, socketPath(value)];
        const stats = await Promise.all(names.map(name => read('lstat', name)));
        stats.forEach((s, i) => {
            const owner = i === 0 ? 0 : 13006, mode = i === 0 ? 0o1777 : i === 3 ? 0o600 : 0o700;
            if (!s || s.uid !== owner || s.gid !== owner || (s.mode & 0o7777) !== mode ||
                !(i === 3 ? s.isSocket() : s.isDirectory())) throw fault('private-path-permissions');
            if (previous && (s.dev !== previous[i].dev || s.ino !== previous[i].ino)) throw fault('private-path-replaced');
        });
        return stats.map(s => ({ dev: s.dev, ino: s.ino }));
    }
    function rejectWaiting(code) {
        if (acquisition) { acquisition.reject(fault(code)); acquisition = undefined; }
        if (profileRequest) { profileRequest.reject(fault(code)); profileRequest = undefined; }
    }
    function completeClose() {
        if (ended) return;
        ended = true; clearRepeat(watch); [acquireTimer, closeTimer, endTimer, writeTimer].forEach(clear);
        queued = writing = undefined; expected = []; readBuffer = '';
        if (socket) { try { socket.destroy(); } catch (_) {} }
        if (restored || noChange) closingResolve({ ok: true, changed: setSent && !noChange,
            restoration: noChange ? 'not-required' : 'observed', epoch, generation });
        else closingReject(fault('restore-unconfirmed'));
    }
    function disconnect() {
        if (ended) return;
        queued = undefined; clear(writeTimer); clear(endTimer);
        try { if (socket && !lost) socket.end('CLOSE\n'); } catch (_) {}
        endTimer = later(completeClose, 100);
        if (!socket || lost) completeClose();
    }
    function beginClose(code, notify) {
        if (closing) return closePromise;
        closing = true;
        closePromise = new Promise((resolve, reject) => { closingResolve = resolve; closingReject = reject; });
        // The owner may ask for close after an asynchronous failure; never leave
        // an unhandled rejection while still returning the same rejecting promise.
        closePromise.catch(() => {});
        clearRepeat(watch); clear(acquireTimer); queued = undefined;
        rejectWaiting(code || 'cancelled');
        noChange = !setSent || setRejected;
        closeTimer = later(completeClose, 3000);
        if (noChange) disconnect();
        else if (lost || !socket || epoch === undefined) completeClose();
        else send('RESTORE', 'RESTORE ' + epoch);
        if (notify && !failure) {
            failure = code;
            if (typeof options.onError === 'function') { try { options.onError(code); } catch (_) {} }
        }
        return closePromise;
    }
    function fail(code, transportLost) {
        if (transportLost) lost = true;
        if (!closing) beginClose(code, true);
        else if (transportLost) completeClose();
    }
    function send(kind, line, receive) {
        if (ended || lost || !socket || !connected || (closing && kind !== 'RESTORE')) return false;
        const command = { kind, line: line + '\n', receive };
        if (writing) {
            // At most one control command waits behind one write. Periodic
            // GET/LEASE calls coalesce; RESTORE supersedes a queued SET.
            if (kind === 'RESTORE' || (!queued && (kind === 'SET' || kind === 'REARM' || receive))) queued = command;
            return !!queued && queued === command;
        }
        write(command); return true;
    }
    function write(command) {
        if (ended || lost || (closing && command.kind !== 'RESTORE')) return;
        // Drain every pre-SET reply first. Otherwise a delayed GET/ready can
        // arrive after SET was written and look like loss of the new format.
        if ((command.kind === 'SET' || command.kind === 'REARM') && expected.length) { queued = command; return; }
        if (command.kind === 'SET' || command.kind === 'REARM') {
            if (now() >= acquireUntil || !last || last.phase !== (command.kind === 'SET' ? 'ready' : 'done') ||
                !baseline(last) || last.dirty || last.uncertain) return fail('baseline-changed');
            if (command.kind === 'REARM' && (last.generation !== rearmFrom.generation || last.updateSeq !== rearmFrom.updateSeq))
                return fail('bridge-rearm-stale');
        }
        if (expected.length >= 4) return fail('bridge-response-backlog');
        writing = command; command.at = now(); expected.push(command);
        if (command.kind === 'SET') { setSent = true; lastLeaseAt = command.at; }
        if (command.kind === 'REARM') rearmSent = true;
        if (command.kind === 'LEASE') lastLeaseAt = command.at;
        if (command.kind === 'RESTORE') restoreSent = true;
        writeTimer = later(() => fail('bridge-write-timeout', true), 250);
        try {
            socket.write(command.line, error => {
                if (ended || writing !== command) return;
                clear(writeTimer); writing = undefined;
                if (error) return fail('bridge-write', true);
                const next = queued; queued = undefined;
                if (next) write(next);
            });
        } catch (_) { fail('bridge-write', true); }
    }
    async function prepareMutation(kind) {
        if (prepared || closing || ended) return;
        prepared = true;
        try {
            const current = await readIdentity(identity.pid);
            await verifyPaths(identity, paths);
            if (closing || ended) return;
            if (!equalIdentity(current, identity)) throw fault('process-changed');
            if (now() >= acquireUntil) throw fault('acquire-timeout');
            if (!last || last.phase !== (kind === 'SET' ? 'ready' : 'done') || !baseline(last) || last.dirty || last.uncertain)
                throw fault('baseline-changed');
            if (kind === 'REARM') {
                if (rearmSent || setSent) throw fault('bridge-rearm-repeat');
                rearmFrom = { generation: last.generation, updateSeq: last.updateSeq };
                if (!send('REARM', 'REARM ' + epoch + ' ' + rearmFrom.generation + ' ' + rearmFrom.updateSeq)) throw fault('bridge-command-busy');
            } else if (!send('SET', 'SET ' + epoch + ' ' + selected)) throw fault('bridge-command-busy');
        } catch (error) { if (!closing) fail(error.code || 'acquire-validation'); }
    }
    function receive(value) {
        if (ended) return;
        if (!validStatus(value) || !equalIdentity(value, identity)) return fail('bridge-status', true);
        if (epoch === undefined && idle(value)) {
            // The MAIN applet can appear before the phone starts its video session.
            // Consume GET replies without binding the owner to an idle epoch.
            if (value.result !== 'hello' && value.result !== 'state') {
                const pending = expected.shift();
                if (!pending || pending.kind !== 'GET' || value.result !== 'ok') return fail('bridge-response-order', true);
            }
            if (value.writes !== 1 && !closing) fail('bridge-read-only');
            return;
        }
        if (epoch === undefined) epoch = value.epoch;
        if (value.epoch !== epoch) {
            // Never restore an old baseline into the new telephone session.
            lost = true; return fail('bridge-epoch-changed', true);
        }
        if (generation === undefined) generation = value.generation;
        const rearmTransition = rearmSent && !rearmAccepted && rearmFrom &&
            value.generation === rearmFrom.generation + 1 && value.phase === 'ready' && baseline(value) &&
            !value.dirty && !value.uncertain;
        if (value.generation !== generation && !rearmTransition) return fail('bridge-generation-changed', true);
        if (value.updateSeq < updateSeq) return fail('bridge-update-order', true);
        if (setStartedNs && value.setStartedNs !== setStartedNs) return fail('bridge-boundary-changed', true);
        updateSeq = value.updateSeq; last = value; lastAt = now();
        let command;
        if (value.result !== 'hello' && value.result !== 'state') {
            command = expected.shift();
            if (!command || (command.kind === 'GET' ? value.result !== 'ok' : ['accepted', 'rejected'].indexOf(value.result) < 0))
                return fail('bridge-response-order', true);
            if (command.kind === 'SET') {
                setAccepted = value.result === 'accepted';
                setRejected = value.result === 'rejected' && value.phase === 'ready' && value.dirty === 0;
            }
            if (command.kind === 'REARM' && value.result === 'accepted') {
                if (!rearmTransition) return fail('bridge-rearm-state', true);
                rearmAccepted = true; generation = value.generation;
            }
        }
        if (closing) {
            if (restoreSent && value.phase === 'done' && !value.dirty && !value.uncertain && baseline(value)) {
                restored = true; return disconnect();
            }
            if (value.phase === 'blocked') return disconnect();
            return;
        }
        if (value.writes !== 1) return fail('bridge-read-only');
        if (value.uncertain || value.phase === 'blocked') return fail('bridge-uncertain');
        if (value.result === 'rejected') return fail(command && command.kind === 'REARM' ? 'bridge-rearm-rejected' : 'bridge-command-rejected');
        if (!setSent && ['applying', 'active', 'restoring'].indexOf(value.phase) >= 0) return fail('format-epoch-busy');
        if (setSent && ['applying', 'active'].indexOf(value.phase) < 0) return fail('bridge-format-lost');
        if (value.baseline && !baseline(value)) return fail('bridge-baseline');
        if (command && command.kind === 'REARM' && rearmAccepted) {
            prepared = false;
            // The next periodic GET supplies a fresh ready snapshot. Do not
            // enqueue SET from the REARM reply or an unsolicited state update.
        }
        if (command && command.kind === 'GET' && !setSent && (value.phase === 'ready' || value.phase === 'done')) {
            if (!baseline(value) || value.dirty) return fail('bridge-baseline');
            prepareMutation(value.phase === 'done' ? 'REARM' : 'SET');
        }
        if (setAccepted && value.phase === 'active') {
            if (!baseline(value) || value.dirty !== 1) return fail('bridge-active-state');
            if (value.setStartedNs === '0') return fail('bridge-boundary-missing');
            setStartedNs = value.setStartedNs;
            if (acquisition) {
                if (now() >= acquireUntil) return fail('acquire-timeout');
                const pending = acquisition; acquisition = undefined; clear(acquireTimer);
                pending.resolve(Object.freeze({ pid: identity.pid, starttime: identity.starttime, epoch, generation }));
            }
        }
        if (command && command.receive) command.receive(value);
        if (queued && !writing && !expected.length && !closing) {
            const next = queued; queued = undefined; write(next);
        }
    }
    function data(chunk) {
        if (ended) return;
        if (!Buffer.isBuffer(chunk) || chunk.length > 8192) return fail('bridge-status-size', true);
        const text = chunk.toString('utf8');
        if (/[^\x20-\x7e\n]/.test(text)) return fail('bridge-status-encoding', true);
        readBuffer += text;
        let at;
        while ((at = readBuffer.indexOf('\n')) >= 0) {
            if (!at || at >= statusLimit) return fail('bridge-status-size', true);
            const line = readBuffer.slice(0, at); readBuffer = readBuffer.slice(at + 1);
            let value;
            try { value = JSON.parse(line); } catch (_) { return fail('bridge-status-json', true); }
            receive(value); if (ended) return;
        }
        if (readBuffer.length >= statusLimit) fail('bridge-status-size', true);
    }
    function tick() {
        if (closing || ended) return;
        const at = now();
        if (acquisition && at >= acquireUntil) return fail('acquire-timeout');
        if (expected.length && at - expected[0].at >= 750) return fail('bridge-response-timeout');
        if (setSent && at - lastLeaseAt >= 1000) return fail('bridge-lease-expired');
        if (!connected) return;
        if (setSent) send('LEASE', 'LEASE ' + epoch);
        else if (!prepared) send('GET', 'GET');
    }
    function acquire(value) {
        if (begun || closing || ended) return Promise.reject(fault('acquire-once'));
        if (!value || !validPid(value.pid) || typeof value.starttime !== 'string' || !/^\d{1,24}$/.test(value.starttime))
            return Promise.reject(fault('process-identity'));
        const requested = Object.freeze({ pid: value.pid, starttime: value.starttime });
        const pid = requested.pid;
        begun = true; acquisition = deferred(); const promise = acquisition.promise;
        startedAt = now(); acquireUntil = startedAt + 4000;
        acquireTimer = later(() => fail('acquire-timeout'), 4000);
        watch = repeat(tick, 250);
        (async () => {
            try {
                if (uid() !== 0 || !validPid(pid)) throw fault('root-and-pid-required');
                identity = await readIdentity(pid);
                if (!equalIdentity(identity, requested)) throw fault('process-changed');
                if (closing || ended) return;
                paths = await verifyPaths(identity);
                if (closing || ended) return;
                socket = connect(socketPath(identity));
                socket.on('data', data);
                socket.on('error', () => fail('bridge-socket', true));
                socket.on('end', () => fail('bridge-eof', true));
                socket.on('close', () => { if (closing) completeClose(); else fail('bridge-closed', true); });
                socket.once('connect', () => {
                    (async () => {
                        try {
                            await verifyPaths(identity, paths);
                            if (closing || ended) return;
                            if (!equalIdentity(await readIdentity(pid), identity)) throw fault('process-changed');
                            if (closing || ended) return;
                            connected = true; send('GET', 'GET');
                        } catch (error) { if (!closing) fail(error.code || 'socket-validation'); }
                    })();
                });
            } catch (error) { if (!closing) fail(error.code || 'acquire'); }
        })();
        return promise;
    }
    async function geometryProfile(value) {
        if (closing || ended || !setAccepted || !last || last.phase !== 'active' || last.uncertain || now() - lastAt >= 750)
            throw fault('geometry-not-active');
        if (profileRequest) throw fault('geometry-busy');
        profileRequest = deferred(); const pending = profileRequest;
        pending.promise.catch(() => {});
        try {
            if (!equalIdentity(value, identity) || !equalIdentity(await readIdentity(identity.pid), identity)) throw fault('process-changed');
            if (closing || ended || profileRequest !== pending) throw fault('geometry-not-active');
            if (!send('GET', 'GET', state => {
                if (profileRequest !== pending || closing || ended) return;
                profileRequest = undefined;
                if (state.phase === 'active' && state.epoch === epoch && state.generation === generation &&
                    !state.uncertain && state.dirty === 1 && baseline(state) && state.setStartedNs === setStartedNs)
                    pending.resolve(Object.freeze(Object.assign({}, profile, { setStartedNs })));
                else { pending.reject(fault('geometry-not-active')); fail('bridge-format-lost'); }
            })) throw fault('bridge-command-busy');
        } catch (error) {
            if (profileRequest === pending) profileRequest = undefined;
            pending.reject(error); if (!closing) fail(error.code || 'geometry-validation');
        }
        return pending.promise;
    }
    return { acquire, geometryProfile, close: () => beginClose('cancelled', false),
        state: () => ({ phase: ended ? 'closed' : closing ? 'closing' : last && last.phase || 'idle',
            epoch, generation, updateSeq, pid: identity && identity.pid,
            active: !closing && !ended && !!last && last.phase === 'active' && setAccepted, failure }) };
}

module.exports = { createFormat, statIdentity };
