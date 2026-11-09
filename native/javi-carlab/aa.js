'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

const profileFile = '/var/opt/javi-carlab/aa.json';
const recoveryFile = '/run/javi-carlab/aa-restore.json';
const reserved = [0x197, 0x198, 0x19d, 0x19f];

function ivi(args) {
    return new Promise((resolve, reject) => {
        execFile('/usr/bin/ivi-control', args, {
            env: Object.assign({}, process.env, { XDG_RUNTIME_DIR: '/run/wayland', WAYLAND_DISPLAY: 'wayland-0' }),
            timeout: 1800,
            maxBuffer: 256 * 1024
        }, (err, stdout) => err ? reject(err) : resolve(stdout));
    });
}

function loadProfile(file) {
    let p;
    try { p = JSON.parse(fs.readFileSync(file || profileFile, 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
    const validId = (n) => Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
    if (!p || p.enabled !== true) return null;
    if (![p.state, p.applet, p.layer, p.surface].every(validId) || reserved.indexOf(p.surface) >= 0 ||
        typeof p.process !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(p.process)) throw new Error('Perfil AA incompleto o superficie reservada');
    return p;
}

function layerInfo(scene, profile) {
    const blocks = new Map();
    const heading = /^[ \t]*(screen|layer|surface)[ \t]+(\d+)[ \t]*:/gim;
    const headings = [];
    let match;
    while ((match = heading.exec(scene))) headings.push(match);
    headings.forEach((m, index) => {
        blocks.set(m[1].toLowerCase() + ':' + Number(m[2]), scene.slice(m.index + m[0].length, index + 1 < headings.length ? headings[index + 1].index : scene.length));
    });
    const layer = blocks.get('layer:' + profile.layer) || '';
    const surface = blocks.get('surface:' + profile.surface) || '';
    const ids = (/^[ \t]*surfaces:[ \t]*([^\r\n]*)/im.exec(layer) || [])[1];
    const owner = (/^\s*process:\s*(\S+)\s+\(\d+\)/im.exec(surface) || [])[1];
    const rect = /(?:^|\s)dst rect\s*[:(]\s*(-?\d+)\s*,\s*(-?\d+)\s*,\s*(\d+)\s*,\s*(\d+)/im.exec(layer);
    if (!ids || ids.trim().split(/[\s,]+/).length !== 1 || Number(ids.trim()) !== profile.surface ||
        !owner || owner.split('/').pop() !== profile.process || !rect || !Number(rect[3]) || !Number(rect[4])) return null;
    return rect.slice(1).map(Number);
}

function fit(original, box) {
    const scale = Math.min(box.w / original[2], box.h / original[3]);
    const w = Math.round(original[2] * scale);
    const h = Math.round(original[3] * scale);
    return [box.x + Math.floor((box.w - w) / 2), box.y + Math.floor((box.h - h) / 2), w, h];
}

function equal(a, b) { return a && b && a.every((n, i) => n === b[i]); }

function matches(ctx, p) { return ctx && ctx.applet === p.applet && ctx.state === p.state; }

function create(profile, control, file) {
    const run = control || ivi;
    const recovery = file || recoveryFile;
    let move;
    const get = (p) => run(['scene']).then((scene) => layerInfo(scene, p));
    const set = (p, rect) => run(['layer', String(p.layer), 'dstrect'].concat(rect.map(String)));

    async function restore() {
        let data = move;
        if (!data) {
            try { data = JSON.parse(fs.readFileSync(recovery, 'utf8')); }
            catch (err) { if (err.code === 'ENOENT') return; throw err; }
        }
        const actual = await get(data.profile);
        if (!actual) throw new Error('La capa AA no está disponible para restaurar');
        if (equal(actual, data.target)) {
            await set(data.profile, data.original);
            if (!equal(await get(data.profile), data.original)) throw new Error('No se confirmó la restauración de AA');
        }
        fs.unlinkSync(recovery);
        move = null;
    }

    return {
        matches(ctx) { return !!profile && matches(ctx, profile); },
        active() { return !!move; },
        async place(box) {
            if (fs.existsSync(recovery)) await restore();
            const original = await get(profile);
            if (!original) return null;
            const target = fit(original, box);
            if (equal(original, target)) throw new Error('AA ya ocupa el destino esperado');
            const data = { profile, original, target };
            fs.writeFileSync(recovery, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
            move = data;
            await set(profile, target);
            if (!equal(await get(profile), target)) throw new Error('Winston no mantuvo Android Auto a la izquierda');
            return target;
        },
        async placed() { return !!move && equal(await get(profile), move.target); },
        restore
    };
}

if (require.main === module && process.argv[2] === '--restore') {
    create(null).restore().catch((err) => { console.warn('CarLauncher AA: ' + err.message); process.exitCode = 1; });
}

module.exports = { create, fit, layerInfo, loadProfile };
