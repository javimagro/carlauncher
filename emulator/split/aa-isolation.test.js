'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { layerInfo, create } = require('../../native/javi-carlab/aa');

const profile = { state: 1, applet: 2, layer: 600, surface: 601, process: 'projection' };
function scene(p = profile) {
    return 'screen 4:\n  layers: ' + p.layer + '\nlayer ' + p.layer + ':\n  surfaces: ' + p.surface +
        '\n  dst rect: 0,0,1280,720\nsurface ' + p.surface + ':\n  process: /usr/bin/' + p.process + ' (123)\n';
}
test('AA never accepts Hmi8, its central surface, or a cockpit surface for relocation', async () => {
    for (const p of [Object.assign({}, profile, { surface: 100 }),
        Object.assign({}, profile, { process: 'Hmi8' }), Object.assign({}, profile, { process: 'HmiMain3D' }),
        Object.assign({}, profile, { surface: 0x197 })]) {
        assert.equal(layerInfo(scene(p), p), null);
        const commands = [];
        const aa = create(p, async (args) => { commands.push(args); return scene(p); }, 'unused-aa-isolation.json');
        assert.equal(await aa.place({ x: 0, y: 0, w: 1038, h: 468 }), null);
        assert(commands.every((args) => args[0] === 'scene'));
    }
});
test('AA rejects ambiguous scene snapshots and surfaces shared with another layer', () => {
    assert.equal(layerInfo(scene(), profile).length, 4);
    assert.deepEqual(layerInfo(scene().replace(/(screen 4|layer 600|surface 601):/g, '$1'), profile), [0, 0, 1280, 720]);
    assert.deepEqual(layerInfo(scene().replace(/\n/g, '\r\n'), profile), [0, 0, 1280, 720]);
    assert.equal(layerInfo(scene() + scene(), profile), null);
    assert.equal(layerInfo(scene() + 'layer 602:\n  surfaces: 601\n', profile), null);
    assert.equal(layerInfo(scene().replace('screen 4:', 'screen 1:'), profile), null);
    assert.equal(layerInfo(scene() + 'screen 1:\n  layers: 600\n', profile), null);
});
