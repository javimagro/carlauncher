'use strict';

// Manual diagnostic, Node 8 compatible. Never imported by BMWLauncher.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
const diagnostic = require('./Diagnosticar-Escena-Mapa');
const OWNER = 0x424d5701;
const IVI = '/usr/bin/ivi-control';

function rectangle(value) {
  if (!/^\d+,\d+,\d+,\d+$/.test(String(value))) throw new Error('Rectángulo requerido: x,y,ancho,alto');
  const r = String(value).split(',').map(Number);
  if (!r[2] || !r[3] || r[0] + r[2] > 2880 || r[1] + r[3] > 960) throw new Error('Rectángulo fuera de la pantalla central');
  return r;
}

function composeCommands(surface, rect) {
  if (!Number.isInteger(surface) || surface < 0x4d410000 || surface > 0x4d41ffff) throw new Error('ID fuera del rango manual reservado');
  const id = String(surface), r = rectangle(rect.join(','));
  return [
    ['layer', id, 'configure', '1038', '468'],
    ['layer', id, 'srcrect', '0', '0', '1038', '468'],
    ['layer', id, 'dstrect'].concat(r.map(String)),
    ['layer', id, 'opacity', '1'],
    ['layer', id, 'visibility', '1'],
    ['surface', id, 'srcrect', '0', '0', '1038', '468'],
    ['surface', id, 'dstrect', '0', '0', '1038', '468'],
    ['surface', id, 'visibility', '1'],
    ['screen', '4', 'add', id]
  ];
}

function validateNewObjects(before, after, surface, sceneText) {
  diagnostic.buildPlan(before, surface, OWNER);
  const report = diagnostic.diagnose(after, surface);
  if (!report.surface || !report.nativeLayer) throw new Error('Todavía faltan la superficie y capa nativas');
  if (report.containingLayers.length !== 1 || report.containingLayers[0] !== surface) {
    throw new Error('La superficie no pertenece exclusivamente a su nueva capa nativa');
  }
  if (!navigationProducer(sceneText, surface)) {
    throw new Error('La superficie no anuncia NavigationBasic como productor');
  }
  return report;
}

function navigationProducer(sceneText, surface) {
  const block = new RegExp('^surface ' + surface + '\\s*\n([\\s\\S]*?)(?=^(?:surface|layer|screen) |$(?![\\s\\S]))', 'm').exec(sceneText);
  return !!(block && /^\s*process:\s+(?:\/|(?:\.\/)+)usr\/bin\/NavigationBasic \(\d+\)\s*$/m.test(block[1]));
}

function removalCommands(before, after, surface, sceneText) {
  diagnostic.buildPlan(before, surface, OWNER);
  const layer = after.layers.find(function (entry) { return entry.id === surface; });
  const hasSurface = after.surfaces.some(function (entry) { return entry.id === surface; });
  if (layer && (layer.surfaces || []).some(function (id) { return id !== surface; })) {
    throw new Error('La capa propia contiene una superficie ajena; no se elimina');
  }
  if (hasSurface && !navigationProducer(sceneText, surface)) throw new Error('El productor ha cambiado; no se elimina la superficie');
  if (after.layers.some(function (entry) { return entry.id !== surface && (entry.surfaces || []).indexOf(surface) !== -1; })) {
    throw new Error('La superficie aparece en una capa ajena; no se elimina');
  }
  if (after.screens.some(function (entry) { return entry.id !== 4 && (entry.layers || []).indexOf(surface) !== -1; })) {
    throw new Error('La capa aparece fuera de la pantalla central; no se elimina');
  }
  const commands = [];
  if (layer) commands.push(['layer', String(surface), 'destroy']);
  if (hasSurface) commands.push(['surface', String(surface), 'destroy']);
  return commands;
}

function exec(file, args, timeoutMs) {
  return new Promise(function (resolve, reject) {
    childProcess.execFile(file, args, { timeout: timeoutMs || 5000, maxBuffer: 1024 * 1024, env: Object.assign({}, process.env,
      { XDG_RUNTIME_DIR: '/run/wayland', WAYLAND_DISPLAY: 'wayland-0' }) }, function (error, stdout) {
      if (error) return reject(new Error(path.basename(file) + ' terminó sin éxito: ' + (error.code || error.signal)));
      resolve(stdout);
    });
  });
}
function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function save(file, value) {
  fs.writeFileSync(file + '.new', JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(file + '.new', file);
}
function birth(pid) {
  try { return fs.readFileSync('/proc/' + pid + '/stat', 'utf8').replace(/^.*\) /, '').split(' ')[19]; }
  catch (_) { return null; }
}
function recordOwns(directory, surface) {
  try {
    const stat = fs.lstatSync(path.join(directory, 'owned-map.bin'));
    if (!stat.isFile() || stat.size !== 16 || (stat.mode & 0o077) || stat.uid !== process.getuid()) return false;
    const b = fs.readFileSync(path.join(directory, 'owned-map.bin'));
    return b.readUInt32BE(0) === 0x424d4150 && b.readUInt32BE(4) === OWNER && b.readUInt32BE(12) === surface;
  } catch (_) { return false; }
}

async function cleanup(directory) {
  if (!/^\/tmp\/bmwlauncher-map-trial-[A-Za-z0-9]+$/.test(directory)) throw new Error('Directorio de ensayo inválido');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || (stat.mode & 0o077) || stat.uid !== process.getuid()) throw new Error('Directorio privado inválido');
  const lock = path.join(directory, 'cleanup.lock');
  let locked = false;
  for (let i = 0; i < 300 && !locked; ++i) {
    try {
      const fd = fs.openSync(lock, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, birth: birth(process.pid) })); fs.closeSync(fd); locked = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(fs.readFileSync(lock, 'utf8'));
        if (owner.birth && birth(owner.pid) !== owner.birth) { fs.unlinkSync(lock); continue; }
      } catch (_) { /* Another cleaner may be writing/releasing the lock. */ }
      await wait(100);
    }
  }
  if (!locked) throw new Error('Ya hay una limpieza en curso; conserva los archivos del ensayo');
  try { await cleanupLocked(directory); } finally { fs.unlinkSync(lock); }
}

async function cleanupLocked(directory) {
  const stateFile = path.join(directory, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  if (state.done) return;
  if (!state.startedAt || Date.now() < state.startedAt || Date.now() - state.startedAt > 300000) {
    throw new Error('Registro caducado: no reutilizar handles antiguos; revisar manualmente el estado');
  }
  // Ownership was recorded by the helper before advertising the newly-created handle.
  const owns = !!state.created || recordOwns(directory, state.surface);
  if (state.pid && state.birth && birth(state.pid) === state.birth) {
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 130 && birth(state.pid) === state.birth; ++i) await wait(100);
    if (birth(state.pid) === state.birth) {
      state.cleanupError = 'El auxiliar no terminó; se conserva el registro para recuperar su handle';
      save(stateFile, state);
      throw new Error(state.cleanupError);
    }
  }
  if (recordOwns(directory, state.surface)) await exec(state.native, ['--cleanup', directory], 15000);
  if (owns) {
    const snapshotText = await exec(IVI, ['scene']);
    const snapshot = diagnostic.parseScene(snapshotText);
    // Only remove IDs proven absent before the trial; never replay a whole screen render order.
    const commands = removalCommands(state.before, snapshot, state.surface, snapshotText);
    for (let i = 0; i < commands.length; ++i) await exec(IVI, commands[i]);
  }
  const finalText = await exec(IVI, ['scene']);
  fs.writeFileSync(path.join(directory, 'after.txt'), finalText, { mode: 0o600 });
  const finalScene = diagnostic.parseScene(finalText);
  if (finalScene.layers.concat(finalScene.surfaces).some(function (entry) { return entry.id === state.surface; })) {
    throw new Error('Quedan objetos con el ID del ensayo; requiere revisión manual, sin reutilizar handles existentes');
  }
  state.done = true; save(stateFile, state);
}

async function run(options) {
  if (process.platform !== 'linux' || process.env.BMWLAUNCHER_MAP_TRIAL !== '1') {
    throw new Error('Solo ejecución manual en MGU, con BMWLAUNCHER_MAP_TRIAL=1 y autorización vigente');
  }
  if (!/^[a-fA-F0-9]{16}$/.test(options.scene) || !/^424d574c/i.test(options.scene) || /^0{8}$/.test(options.scene.slice(8))) {
    throw new Error('Se necesita un sceneId nuevo de 64 bits en el espacio propio 424d574cXXXXXXXX');
  }
  const commands = composeCommands(options.surface, options.rect);
  const native = fs.realpathSync(options.native);
  const baselineText = await exec(IVI, ['scene']);
  const before = diagnostic.parseScene(baselineText);
  diagnostic.buildPlan(before, options.surface, OWNER);
  if (!before.screens.some(function (screen) { return screen.id === 4; })) throw new Error('No está la pantalla central esperada');
  const directory = fs.mkdtempSync('/tmp/bmwlauncher-map-trial-'); fs.chmodSync(directory, 0o700);
  const stateFile = path.join(directory, 'state.json');
  const state = { native: native, surface: options.surface, before: before, created: false, done: false, startedAt: Date.now() };
  save(stateFile, state);
  fs.writeFileSync(path.join(directory, 'before.txt'), baselineText, { mode: 0o600 });
  const watchdog = childProcess.spawn(process.execPath, [__filename, '--watchdog', directory], { detached: true, stdio: 'ignore' });
  watchdog.unref();
  const session = childProcess.spawn(native, ['--trial', String(options.surface), options.scene, directory], {
    stdio: ['pipe', 'pipe', 'pipe'], env: process.env
  });
  state.pid = session.pid; state.birth = birth(session.pid); save(stateFile, state);
  let buffer = '', created = false, closed = false, processError = null;
  const log = fs.createWriteStream(path.join(directory, 'rpc.log'), { mode: 0o600 });
  let logged = 0;
  function writeLog(chunk) { if (logged < 256 * 1024) { log.write(chunk.slice(0, 256 * 1024 - logged)); logged += chunk.length; } }
  session.stderr.on('data', writeLog);
  session.stdout.on('data', function (chunk) {
    writeLog(chunk); buffer += chunk.toString('utf8');
    if (buffer.length > 16384) { processError = new Error('Salida de sonda excesiva'); session.kill('SIGTERM'); return; }
    let end;
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (line.charAt(0) !== '{') continue;
      try {
        const message = JSON.parse(line);
        if (message.event === 'created' && message.surface === options.surface && recordOwns(directory, options.surface)) {
          created = true; state.created = true; save(stateFile, state);
        }
      } catch (_) { /* Non-JSON native logging is not a state transition. */ }
    }
  });
  session.on('error', function (error) { processError = error; closed = true; });
  session.on('close', function () { closed = true; log.end(); });
  session.stdin.on('error', function () {});
  process.on('SIGTERM', function () { session.kill('SIGTERM'); });
  process.on('SIGINT', function () { session.kill('SIGTERM'); });
  try {
    for (let i = 0; i < 180 && !created && !closed; ++i) await wait(100);
    if (!created || closed) throw processError || new Error('La creación no quedó confirmada');
    let ready = false;
    for (let i = 0; i < 30 && !closed; ++i) {
      const text = await exec(IVI, ['scene']);
      const scene = diagnostic.parseScene(text);
      if (scene.surfaces.some(function (s) { return s.id === options.surface; }) &&
          scene.layers.some(function (l) { return l.id === options.surface; })) {
        validateNewObjects(before, scene, options.surface, text); ready = true; break;
      }
      await wait(100);
    }
    if (!ready || closed) throw new Error('Objetos nativos propios no disponibles');
    for (let i = 0; i < commands.length; ++i) await exec(IVI, commands[i]);
    session.stdin.write('SHOW\n');
    for (let i = 0; i < 20 && !closed; ++i) {
      await wait(1000);
      const text = await exec(IVI, ['scene']);
      fs.writeFileSync(path.join(directory, 'during.txt'), text, { mode: 0o600 });
      const report = diagnostic.diagnose(diagnostic.parseScene(text), options.surface);
      process.stdout.write(JSON.stringify({ second: i + 1, status: report.status,
        frames: report.surface && report.surface.frames, nativeVisible: report.nativeLayer && report.nativeLayer.visibility }) + '\n');
    }
    if (!closed) session.stdin.end('STOP\n');
  } finally {
    if (!closed) session.kill('SIGTERM');
    for (let i = 0; i < 60 && !closed; ++i) await wait(100);
    await cleanup(directory);
    process.stdout.write('Archivos privados de ensayo: ' + directory + '\n');
  }
}

async function main(args) {
  if ((args[0] === '--watchdog' || args[0] === '--cleanup') && args.length === 2) {
    if (process.platform !== 'linux' || process.env.BMWLAUNCHER_MAP_TRIAL !== '1') throw new Error('Recuperación manual solo en MGU autorizada');
    if (args[0] === '--watchdog') await wait(55000);
    await cleanup(args[1]); return;
  }
  if (args[0] !== '--run' || args.length !== 5) {
    throw new Error('Uso manual en MGU: node Ensayar-Mapa-Propio.js --run RUTA_SONDA SUPERFICIE SCENE_HEX x,y,ancho,alto');
  }
  await run({ native: args[1], surface: Number(args[2]), scene: args[3], rect: rectangle(args[4]) });
}
if (require.main === module) main(process.argv.slice(2)).catch(function (error) {
  process.stderr.write(error.message + '\n'); process.exitCode = 1;
});
module.exports = { rectangle: rectangle, composeCommands: composeCommands, validateNewObjects: validateNewObjects,
  removalCommands: removalCommands };
