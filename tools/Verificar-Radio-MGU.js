'use strict';
const fs = require('fs');
const assert = require('assert');
const { services } = require('../apps/javi_carlauncher/radio-datos');
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const manifest = require('../apps/javi_carlauncher/package/manifest.json');
function member(c, group, name) { return c[group] && c[group][name] || c.extends && member(catalog.interfaces[c.extends], group, name); }
for (const d of Object.values(services)) {
    const c = catalog.interfaces[d.name]; assert(c, d.name); assert.strictEqual(catalog.instanceIDs[d.name]['1'], 1);
    const p = { instances: ['1'], attributes: {} };
    for (const name of d.attributes) { const field = member(c, 'fields', name); assert(field.getter && field.notifier); p.attributes[name] = 'rs'; }
    p.methods = d.methods; d.methods.forEach((name) => assert(member(c, 'methods', name)));
    if (d.broadcasts) { p.broadcasts = d.broadcasts; d.broadcasts.forEach((name) => assert(member(c, 'events', name))); }
    assert.deepStrictEqual(manifest.proxies[d.name], p);
}
const tuner = catalog.interfaces[services.tuner.name];
assert.strictEqual(tuner.serviceId, 45108); assert.strictEqual(tuner.version.major, 2);
assert.deepStrictEqual(member(tuner, 'methods', 'selectStation').inputs.map((v) => v.name), ['listType', 'dataBaseIdentifier', 'positionIndex']);
assert.deepStrictEqual(member(tuner, 'methods', 'getStationListMetaData').inputs.map((v) => v.name), ['listType', 'pictures', 'epgDataScope', 'startPosition', 'length']);
const types = catalog.datatypes, generic = 'de.bmw.infotainment.tuner.common.generic.tunergenerictypes.TunerGenericTypes.';
assert.strictEqual(types[generic + 'ListType'].items.LT_RECEIVABLE_FM_DAB, 2);
assert.strictEqual(types[generic + 'ListType'].items.LT_PRESETS_RADIO, 7);
assert.strictEqual(types[generic + 'ListType'].items.LT_TOPSTATIONS_RADIO, 10);
assert.strictEqual(types[generic + 'PtyTableType'].items.PTT_RDS_DAB, 0);
assert(types[generic + 'StationListEntry'].members.some((m) => m.name === 'stationIconPicture'));
console.log('Radio: 2 interfaces, herencia de TunerGeneric, instancia 1, métodos, listas, imágenes y permisos verificados con el catálogo MGU21.');
