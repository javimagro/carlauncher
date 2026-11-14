'use strict';

// Herramienta de PC: lee una captura privada de `ivi-control scene`.
// No conecta con la MGU, ejecuta comandos, modifica mapas ni instala componentes.
const fs = require('fs');

const MAX_BYTES = 1024 * 1024;
const VISIBLE = 0x43;

function readUint(value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 0xfffffffe) {
    throw new Error(label + ' debe ser un UInt32 no reservado');
  }
  return value;
}

function parseScene(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > MAX_BYTES) {
    throw new Error('Captura de escena ausente o demasiado grande');
  }
  const result = { screens: [], layers: [], surfaces: [] };
  let current = null;
  text.split(/\r?\n/).forEach(function (line) {
    const heading = /^(screen|layer|surface)\s+(\d+)\s*$/.exec(line);
    if (heading) {
      current = { id: Number(heading[2]) };
      const key = heading[1] === 'screen' ? 'screens' : heading[1] === 'layer' ? 'layers' : 'surfaces';
      if (result[key].some(function (entry) { return entry.id === current.id; })) {
        throw new Error('La captura contiene escenas repetidas; usa solo una instantánea');
      }
      result[key].push(current);
      return;
    }
    if (!current) return;
    const field = /^\s*(visibility|size|src rect|dst rect|frames|layers|surfaces):\s*(.*?)\s*$/.exec(line);
    if (!field) return;
    const key = field[1], value = field[2];
    if (key === 'visibility' || key === 'frames') {
      if (!/^\d+$/.test(value)) throw new Error('Contador de escena inválido');
      current[key] = Number(value);
    } else if (key === 'size') {
      const size = /^(\d+)x(\d+)$/.exec(value);
      if (!size) throw new Error('Tamaño de escena inválido');
      current.size = size.slice(1).map(Number);
    } else if (key === 'layers' || key === 'surfaces') {
      if (value && !/^\d+(\s+\d+)*$/.test(value)) throw new Error('Lista de escena inválida');
      current[key] = value ? value.split(/\s+/).map(Number) : [];
    } else {
      const rect = /^(\d+),\s*(\d+),\s*(\d+),\s*(\d+)$/.exec(value);
      if (!rect) throw new Error('Rectángulo de escena inválido');
      current[key === 'src rect' ? 'source' : 'destination'] = rect.slice(1).map(Number);
    }
  });
  if (!result.screens.length) throw new Error('La captura no contiene ninguna pantalla');
  return result;
}

function diagnose(scene, surfaceId) {
  readUint(surfaceId, 'ID de superficie propia');
  const surface = scene.surfaces.find(function (entry) { return entry.id === surfaceId; });
  const nativeLayer = scene.layers.find(function (entry) { return entry.id === surfaceId; });
  const owners = scene.layers.filter(function (entry) {
    return (entry.surfaces || []).indexOf(surfaceId) !== -1;
  });
  return {
    surface: surface || null,
    // NavigationBasic 27.0 usa el ID de superficie como ID de su capa IVI.
    nativeLayer: nativeLayer || null,
    containingLayers: owners.map(function (entry) { return entry.id; }),
    nativeLayerOnScreens: scene.screens.filter(function (entry) {
      return (entry.layers || []).indexOf(surfaceId) !== -1;
    }).map(function (entry) { return entry.id; }),
    hasProducedFrames: !!(surface && surface.frames > 0),
    status: !surface ? 'SURFACE_MISSING' :
      surface.frames === undefined ? 'FRAME_COUNT_UNKNOWN' :
      surface.frames === 0 ? 'NO_FRAMES' : 'FRAMES_REQUIRE_VISUAL_CONFIRMATION',
    warnings: [
      !nativeLayer ? 'Falta la capa nativa de esta superficie.' : null,
      nativeLayer && nativeLayer.visibility !== 1 ? 'La capa nativa no está visible.' : null,
      nativeLayer && (!nativeLayer.size || !nativeLayer.size[0] || !nativeLayer.size[1]) ?
        'La capa nativa no tiene tamaño útil.' : null,
      owners.length > 1 ? 'La superficie está en varias capas; no repetir la composición duplicada del ensayo anterior.' : null
    ].filter(Boolean)
  };
}

function buildPlan(scene, surfaceId, ownerId) {
  readUint(surfaceId, 'Nuevo ID de superficie/capa');
  readUint(ownerId, 'Propietario del ensayo');
  if (scene.layers.concat(scene.surfaces).some(function (entry) { return entry.id === surfaceId; }) ||
      scene.screens.some(function (entry) { return (entry.layers || []).indexOf(surfaceId) !== -1; })) {
    throw new Error('El ID ya existe en la escena; no pertenece a un ensayo nuevo');
  }
  return {
    execute: false,
    requiresFreshSceneAndAuthorization: true,
    owner: ownerId,
    newSurfaceId: surfaceId,
    nativeLayerId: surfaceId,
    limitSeconds: 45,
    steps: [
      { action: 'reserve-own-ids-and-arm-independent-cleanup', detail: 'Confirmar además que el sceneId RAMSES nuevo no está ocupado; IVI no enumera las escenas RAMSES.' },
      { action: 'create-own-instance', service: 'FA94', instance: 1, version: '30.11', method: 2,
        detail: 'Guardar únicamente el handle NUEVO de la respuesta; no aceptar MAIN, un handle existente ni un timeout como creación.' },
      { action: 'configure-native-layer', layerId: surfaceId, surfaceId: surfaceId,
        detail: 'Esperar capa/superficie nuevas, comprobar NavigationBasic como productor, configurar tamaño y rectángulos del panel izquierdo, añadir SOLO esta capa a la pantalla central preservando su orden anterior. No crear una segunda capa.' },
      { action: 'set-own-visibility', service: 'FA95', instance: 1, version: '5.2', method: 0x30,
        args: [ownerId, 'NEW_HANDLE', VISIBLE],
        detail: 'Correlacionar client/session/request y capturar respuesta o error; no acumular órdenes si expira.' },
      { action: 'observe', detail: 'Contadores antes/después, fuente RGBA, respuesta de transacción y captura; cero frames sigue siendo fallo aunque el RPC sea OK.' },
      { action: 'release-own-instance', service: 'FA95', instance: 1, version: '5.2', method: 3,
        args: [ownerId, 'NEW_HANDLE'] },
      { action: 'restore-and-compare', detail: 'Retirar únicamente objetos propios; comparar la escena con la referencia y confirmar cockpit intacto. No parar ni borrar guiado.' }
    ]
  };
}

function main(args) {
  if (args.length !== 2 && args.length !== 4) {
    throw new Error('Uso: node tools/map-runtime/Diagnosticar-Escena-Mapa.js ESCENA.txt SUPERFICIE [--plan PROPIETARIO]');
  }
  if (args.length === 4 && args[2] !== '--plan') throw new Error('Opción desconocida');
  const stat = fs.statSync(args[0]);
  if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Captura demasiado grande o no regular');
  const scene = parseScene(fs.readFileSync(args[0], 'utf8'));
  const value = args.length === 4 ? buildPlan(scene, Number(args[1]), Number(args[3])) : diagnose(scene, Number(args[1]));
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(error.message + '\n');
    process.exitCode = 1;
  }
}

module.exports = { parseScene: parseScene, diagnose: diagnose, buildPlan: buildPlan };
