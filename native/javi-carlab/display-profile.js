'use strict';

const fs = require('fs');
const { fitArea } = require('./layout');
const configFile = '/var/opt/mgu-render/mgu-render.local.conf';
const pendingFile = '/run/bmwlauncher-tall-pending';
const begin = '\n# BEGIN BMWLauncher tall touch\n';
const end = '# END BMWLauncher tall touch\n';
const block = begin + 'touch_area = 0,0,2880,840\n' + end;
const tall = { x: 0, y: 0, w: 2880, h: 840 };

function setting(text, key) {
    let value;
    text.split(/\r?\n/).forEach((line) => {
        const match = /^\s*([a-z_]+)\s*=\s*([^#]*?)(?:\s*#.*)?$/.exec(line);
        if (match && match[1] === key) value = match[2].replace(/\s/g, '');
    });
    return value;
}

function editConfig(text, enable) {
    if (text.indexOf('BEGIN BMWLauncher tall touch') >= 0 || text.indexOf('END BMWLauncher tall touch') >= 0) {
        if (text.indexOf(block) < 0 || text.indexOf(block) !== text.lastIndexOf(block)) {
            throw new Error('El bloque de vista alta ha sido modificado; conserva la configuración y revísalo');
        }
        if (!enable) return text.replace(block, '');
    } else if (!enable) return text;
    const touch = setting(text, 'touch_area');
    const area = setting(text, 'app_area');
    const allowed = (value) => value === undefined || value === 'auto' || value === '0,76,2880,764' || value === '0,0,2880,840';
    if (!allowed(touch) || !allowed(area)) throw new Error('Área personalizada de mgu-render: no se sustituye automáticamente');
    if (text.indexOf(block) >= 0) {
        if (touch !== '0,0,2880,840') throw new Error('Otra opción anula el toque de la vista alta');
        return text;
    }
    return text + block;
}

function readConfig(file) {
    try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.size > 65536) throw new Error('Configuración de renderer no regular o demasiado grande');
        return fs.readFileSync(file, 'utf8');
    } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}

function configured(text) {
    try { return text.indexOf(block) >= 0 && editConfig(text, true) === text; }
    catch (_) { return false; }
}

function selectEnvironment(env, options) {
    options = options || {};
    if (env.JAVI_DRIVEHUB_TALL !== '1') return false;
    let ready = false;
    try {
        ready = !fs.existsSync(options.pendingFile || pendingFile) && configured(readConfig(options.configFile || configFile));
    } catch (_) { /* A missing/changed configuration keeps the complete, touchable normal view. */ }
    if (!ready) env.JAVI_DRIVEHUB_TALL = '0';
    return ready;
}

function selectArea(screen, info, width, height) {
    if (!screen || screen.w !== 2880 || screen.h !== 960 || !info || !Array.isArray(info.modes) || info.modes.indexOf('layer') < 0) return null;
    const area = info.appArea;
    if (!area || area.x !== 0 || area.w !== 2880 || !((area.y === 76 && area.h === 764) || (area.y === 0 && area.h === 840))) return null;
    // PLACE is per client. Keep the renderer's advertised app_area unchanged for other apps.
    return fitArea(height === 572 ? tall : area, width, height);
}

module.exports = { configFile, pendingFile, editConfig, readConfig, configured, selectEnvironment, selectArea };
