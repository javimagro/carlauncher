'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const directory = '/run/bmwlauncher-aa-focus.lock';

function processIdentity(pid) {
    if (!Number.isInteger(pid) || pid < 1) return null;
    try {
        const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
        const at = text.lastIndexOf(')');
        const fields = text.slice(at + 2).trim().split(/\s+/);
        if (at < 0 || fields[0] === 'Z' || !/^\d+$/.test(fields[19])) return null;
        return { pid, starttime: fields[19] };
    } catch (_) { return null; }
}
function validIdentity(value) {
    return !!value && Number.isInteger(value.pid) && value.pid > 1 && /^\d{1,24}$/.test(value.starttime);
}
function equal(a, b) { return validIdentity(a) && validIdentity(b) && a.pid === b.pid && a.starttime === b.starttime; }
function fault(code) { const error = new Error(code); error.code = code; return error; }

// The directory itself is the atomic lock. Never steal an old/unknown lock:
// without a confirmed restoration, even two dead PIDs do not prove safety.
function createLock(options) {
    options = options || {};
    const root = options.directory || directory;
    const identity = options.identity || processIdentity;
    const self = identity(options.pid || process.pid);
    const file = path.join(root, 'session.json');
    let token;
    function read() {
        try {
            const dir = fs.lstatSync(root), stat = fs.lstatSync(file);
            if (!dir.isDirectory() || !stat.isFile() || stat.nlink !== 1 || stat.size > 2048) throw fault('focus-lock-invalid');
            if (process.platform === 'linux' && (dir.uid !== process.getuid() || stat.uid !== process.getuid() ||
                (dir.mode & 0o777) !== 0o700 || (stat.mode & 0o777) !== 0o600)) throw fault('focus-lock-permissions');
            const value = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (value.version !== 1 || !/^[a-f0-9]{32}$/.test(value.token) || !validIdentity(value.supervisor) ||
                (value.owner !== null && !validIdentity(value.owner)) || typeof value.attempted !== 'boolean') throw fault('focus-lock-invalid');
            return value;
        } catch (error) { throw fault(error.code && /^focus-/.test(error.code) ? error.code : 'focus-lock-unavailable'); }
    }
    function write(value) {
        const temporary = path.join(root, value.token + '.tmp');
        try {
            fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
            fs.renameSync(temporary, file);
        } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
    }
    function held(role) {
        const value = read();
        if (!token || value.token !== token || !equal(value[role], self)) throw fault('focus-lock-owner');
        return value;
    }
    return {
        acquire() {
            if (!validIdentity(self)) throw fault('focus-identity');
            try { fs.mkdirSync(root, 0o700); } catch (error) { throw fault(error.code === 'EEXIST' ? 'focus-locked' : 'focus-lock-create'); }
            token = crypto.randomBytes(16).toString('hex');
            // A crash before publication leaves an unknown lock, deliberately
            // unavailable until /run is reset or an explicit recovery is done.
            write({ version: 1, token, supervisor: self, owner: null, attempted: false });
            return token;
        },
        join(value) {
            if (!/^[a-f0-9]{32}$/.test(value || '') || !validIdentity(self)) throw fault('focus-identity');
            const record = read();
            if (record.token !== value) throw fault('focus-lock-owner');
            token = value; return self;
        },
        register(owner) {
            const value = held('supervisor');
            if (value.owner || !equal(identity(owner && owner.pid), owner)) throw fault('focus-owner-identity');
            value.owner = owner; write(value);
        },
        authorize() {
            const value = held('supervisor');
            if (!value.owner || !equal(identity(value.owner.pid), value.owner)) throw fault('focus-owner-identity');
            value.attempted = true; write(value);
        },
        verify(role) { return held(role); },
        alive(role) { const value = read(); return !!value[role] && equal(identity(value[role].pid), value[role]); },
        release(role) {
            const value = held(role), other = role === 'owner' ? 'supervisor' : 'owner';
            if (value[other] && equal(identity(value[other].pid), value[other])) return false;
            // No acquisition can race this removal: mkdir continues to fail
            // until rmdir, and there are no focus mutations after release.
            fs.unlinkSync(file); fs.rmdirSync(root); token = undefined; return true;
        }
    };
}

module.exports = { createLock, processIdentity, validIdentity, equal, directory };
