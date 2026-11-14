'use strict';

const fs = require('fs'), path = require('path'), crypto = require('crypto');
const providers = {
    openai: { label: 'OpenAI', model: 'gpt-realtime-2.1', voices: ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'] },
    gemini: { label: 'Gemini', model: 'gemini-3.8-live', voices: ['Kore', 'Zephyr', 'Puck', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'] }
};
const defaults = () => ({ provider: 'openai', voices: { openai: 'marin', gemini: 'Kore' }, keys: { openai: '', gemini: '' }, speak: true });
const validKey = (s) => typeof s === 'string' && /^[A-Za-z0-9_\-]{16,2048}$/.test(s);
const call = (name, args) => new Promise((resolve, reject) => fs[name].apply(fs, args.concat((err, value) => err ? reject(err) : resolve(value))));
async function read(file, limit) {
    const info = await call('lstat', [file]);
    if (!info.isFile() || info.size > limit) throw new Error('CONFIG_FILE');
    return call('readFile', [file]);
}
function createConfig(directory) {
    let value = defaults(), master, writable = true, failure = '', queue = Promise.resolve();
    const file = directory && path.join(directory, 'settings.enc');
    const keyFile = directory && path.join(directory, 'device.key');
    const ready = (async () => {
        if (!directory) return;
        let found = false;
        try {
            const bytes = await read(file, 16384); found = true; master = await read(keyFile, 32);
            if (master.length !== 32 || bytes.length < 28) throw new Error('CONFIG_FILE');
            const decipher = crypto.createDecipheriv('aes-256-gcm', master, bytes.slice(0, 12));
            decipher.setAuthTag(bytes.slice(12, 28));
            const saved = JSON.parse(Buffer.concat([decipher.update(bytes.slice(28)), decipher.final()]).toString('utf8'));
            if (!Object.prototype.hasOwnProperty.call(providers, saved.provider) || !saved.voices || !saved.keys) throw new Error('CONFIG_FILE');
            for (const p of Object.keys(providers)) {
                if (!providers[p].voices.includes(saved.voices[p]) || typeof saved.keys[p] !== 'string' || saved.keys[p] && !validKey(saved.keys[p])) throw new Error('CONFIG_FILE');
            }
            value = { provider: saved.provider, voices: saved.voices, keys: saved.keys, speak: saved.speak !== false };
        } catch (e) { if (found || e.code !== 'ENOENT') { writable = false; failure = 'No se puede leer la configuración privada'; } }
    })();
    async function persist(next) {
        if (!directory) { value = next; return; }
        await call('mkdir', [directory, 0o700]).catch((e) => { if (e.code !== 'EEXIST') throw e; });
        const info = await call('lstat', [directory]);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('CONFIG_DIRECTORY');
        await call('chmod', [directory, 0o700]);
        if (!master) {
            try { master = await read(keyFile, 32); }
            catch (e) {
                if (e.code !== 'ENOENT') throw e;
                const generated = crypto.randomBytes(32);
                await call('writeFile', [keyFile, generated, { flag: 'wx', mode: 0o600 }]); master = generated;
            }
        }
        if (master.length !== 32) throw new Error('CONFIG_KEY');
        const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
        const temp = file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
        try {
            await call('writeFile', [temp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 }]);
            await call('rename', [temp, file]); value = next;
        } finally { await call('unlink', [temp]).catch(() => {}); }
    }
    return {
        ready,
        snapshot() { return { provider: value.provider, voices: Object.assign({}, value.voices), speak: value.speak,
            configured: { openai: !!value.keys.openai, gemini: !!value.keys.gemini }, error: failure }; },
        credentials() { return { provider: value.provider, voice: value.voices[value.provider], key: value.keys[value.provider], speak: value.speak }; },
        update(patch) {
            const job = queue.then(() => ready).then(async () => {
                if (!writable) throw new Error('CONFIG_UNREADABLE');
                const next = JSON.parse(JSON.stringify(value)), p = patch.provider || next.provider;
                if (!Object.prototype.hasOwnProperty.call(providers, p)) throw new Error('CONFIG_PROVIDER');
                next.provider = p;
                if (patch.voice !== undefined) {
                    if (!providers[p].voices.includes(patch.voice)) throw new Error('CONFIG_VOICE');
                    next.voices[p] = patch.voice;
                }
                if (patch.key !== undefined) {
                    if (patch.key !== '' && !validKey(patch.key)) throw new Error('CONFIG_API_KEY');
                    next.keys[p] = patch.key;
                }
                if (patch.speak !== undefined) next.speak = patch.speak === true;
                await persist(next); return this.snapshot();
            });
            queue = job.catch(() => {}); return job;
        }
    };
}
module.exports = { providers, validKey, createConfig };
