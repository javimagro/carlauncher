'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const diagnostic = require('../../tools/map-runtime/Diagnosticar-Escena-Mapa');
const runner = require('../../tools/map-runtime/Ensayar-Mapa-Propio');
const id = 0x4d410008;
const baselineText = 'screen 4\n layers: 100\nscreen 5\n layers: 200\n' +
  'layer 100\n surfaces: 100\nlayer 200\n surfaces: 200\nsurface 100\nsurface 200\n';
const baseline = diagnostic.parseScene(baselineText);
function created(producer) {
  return baselineText + 'layer ' + id + '\n visibility: 0\n size: 0x0\n surfaces: ' + id + '\n' +
    'surface ' + id + '\n process: ' + producer + ' (12)\n size: 1038x468\n frames: 0\n';
}

test('el ensayo compone únicamente la capa nativa propia y añade solo esa capa a screen 4', function () {
  const commands = runner.composeCommands(id, [0, 0, 1038, 468]);
  const screenCommands = commands.filter(function (c) { return c[0] === 'screen'; });
  assert.deepEqual(screenCommands, [['screen', '4', 'add', String(id)]]);
  commands.filter(function (c) { return c[0] !== 'screen'; }).forEach(function (c) {
    assert.equal(c[1], String(id));
    assert.notEqual(c[2], 'create');
    assert.notEqual(c[2], 'renderorder');
  });
  assert.throws(function () { runner.composeCommands(200, [0, 0, 1038, 468]); }, /reservado/);
  assert.throws(function () { runner.rectangle('2100,0,1038,468'); }, /fuera/);
});

test('la creación exige IDs libres, productor NavigationBasic y pertenencia exclusiva', function () {
  ['/usr/bin/NavigationBasic', '././usr/bin/NavigationBasic'].forEach(function (producer) {
    const text = created(producer), scene = diagnostic.parseScene(text);
    assert.equal(runner.validateNewObjects(baseline, scene, id, text).status, 'NO_FRAMES');
    assert.throws(function () { runner.validateNewObjects(scene, scene, id, text); }, /ya existe/);
  });
  const other = created('/usr/bin/Other');
  assert.throws(function () { runner.validateNewObjects(baseline, diagnostic.parseScene(other), id, other); }, /productor/);
  const shared = created('/usr/bin/NavigationBasic').replace('surfaces: 100', 'surfaces: 100 ' + id);
  assert.throws(function () { runner.validateNewObjects(baseline, diagnostic.parseScene(shared), id, shared); }, /exclusivamente/);
});

test('la retirada solo borra los IDs nuevos propios y rechaza objetos compartidos o del cockpit', function () {
  const text = created('/usr/bin/NavigationBasic');
  assert.deepEqual(runner.removalCommands(baseline, diagnostic.parseScene(text), id, text),
    [['layer', String(id), 'destroy'], ['surface', String(id), 'destroy']]);
  [
    text.replace('surfaces: ' + id, 'surfaces: ' + id + ' 200'),
    text.replace('layers: 200', 'layers: 200 ' + id),
    text.replace('surfaces: 100', 'surfaces: 100 ' + id),
    text.replace('/usr/bin/NavigationBasic', '/usr/bin/Other')
  ].forEach(function (modified) {
    assert.throws(function () { runner.removalCommands(baseline, diagnostic.parseScene(modified), id, modified); },
      /ajena|fuera|productor/i);
  });
  assert.deepEqual(runner.removalCommands(baseline, baseline, id, baselineText), []);
});
