'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const probe = require('../../tools/map-runtime/Diagnosticar-Escena-Mapa');
const snapshot = 'screen 4\n mode: 2880x960@60.0\n layers: 100 123\n' +
  'layer 100\n visibility: 1\n size: 2880x960\n surfaces: 100\n' +
  'layer 123\n visibility: 0\n size: 0x0\n surfaces: 123\n' +
  'layer 456\n visibility: 1\n size: 1038x468\n surfaces: 123\n' +
  'surface 123\n visibility: 1\n size: 1038x468\n frames: 0\n';

test('el diagnóstico detecta cero cuadros y la capa nativa oculta, incluso con una copia visible', function () {
  const result = probe.diagnose(probe.parseScene(snapshot), 123);
  assert.equal(result.status, 'NO_FRAMES');
  assert.equal(result.hasProducedFrames, false);
  assert.deepEqual(result.containingLayers, [123, 456]);
  assert.equal(result.warnings.length, 3);
});

test('un contador ausente o positivo no se convierte en mapa BMW visualmente validado', function () {
  assert.equal(probe.diagnose(probe.parseScene(snapshot.replace('frames: 0', 'frames: 7')), 123).status,
    'FRAMES_REQUIRE_VISUAL_CONFIRMATION');
  assert.equal(probe.diagnose(probe.parseScene(snapshot.replace('frames: 0', '')), 123).status,
    'FRAME_COUNT_UNKNOWN');
});

test('el plan no escribe en una superficie o capa existente', function () {
  const scene = probe.parseScene(snapshot);
  [100, 123, 456].forEach(function (id) {
    assert.throws(function () { probe.buildPlan(scene, id, 0x424d5701); }, /ya existe/);
  });
  const plan = probe.buildPlan(scene, 789, 0x424d5701);
  assert.equal(plan.execute, false);
  assert.equal(plan.nativeLayerId, plan.newSurfaceId);
  assert.deepEqual(plan.steps.find(function (s) { return s.action === 'set-own-visibility'; }).args,
    [0x424d5701, 'NEW_HANDLE', 67]);
  assert.equal(plan.steps.filter(function (s) { return s.args; }).length, 2);
});

test('el diagnóstico rechaza capturas concatenadas, IDs reservados y tamaños excesivos', function () {
  assert.throws(function () { probe.parseScene(snapshot + snapshot); }, /repetidas/);
  assert.throws(function () { probe.parseScene('screen 4\n' + ' '.repeat(1024 * 1024)); }, /grande/);
  const scene = probe.parseScene(snapshot);
  [0, -1, 0xffffffff, NaN, 3.1].forEach(function (id) {
    assert.throws(function () { probe.buildPlan(scene, id, 1); }, /UInt32/);
  });
});
