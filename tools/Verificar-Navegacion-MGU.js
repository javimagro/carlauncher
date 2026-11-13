'use strict';

// Local verification against the privately extracted catalog, never copy the catalog into the repo.
const fs = require('fs');
const assert = require('assert');
const { services, instance } = require('../apps/javi_carlauncher/navegacion-bmw');
const { contracts } = require('../apps/javi_carlauncher/navegacion-acciones');
const manifest = require('../apps/javi_carlauncher/package/manifest.json');
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = {};
function inherited(c, section, name) {
    return c && (c[section] && c[section][name] || c.extends && inherited(catalog.interfaces[c.extends], section, name));
}
for (const d of Object.keys(services).map((k) => services[k]).concat(Object.keys(contracts).map((k) => contracts[k]))) {
    const c = catalog.interfaces[d.name];
    assert(c, d.name);
    const usedInstance = d.instance || instance;
    assert.strictEqual(catalog.instanceIDs[d.name][usedInstance], usedInstance === '1' ? 1 : 128);
    const permissions = expected[d.name] || (expected[d.name] = { instances: [usedInstance] });
    if (d.attributes) {
        permissions.attributes = permissions.attributes || {};
        const fields = Array.isArray(d.attributes) ? d.attributes : Object.keys(d.attributes);
        for (const name of fields) {
            const mode = Array.isArray(d.attributes) ? 'rs' : d.attributes[name];
            assert(c.fields[name].getter && (mode === 'r' || c.fields[name].notifier), name);
            permissions.attributes[name] = permissions.attributes[name] || mode;
        }
    }
    if (d.methods) { permissions.methods = Array.from(new Set((permissions.methods || []).concat(d.methods))); d.methods.forEach((m) => assert(inherited(c, 'methods', m), d.name + '.' + m)); }
    if (d.broadcasts) { permissions.broadcasts = Array.from(new Set((permissions.broadcasts || []).concat(d.broadcasts))); d.broadcasts.forEach((e) => assert(inherited(c, 'events', e), e)); }
}
Object.keys(expected).forEach((name) => assert.deepStrictEqual(manifest.proxies[name], expected[name]));
const routing = catalog.interfaces[services.routing.name];
assert.deepStrictEqual(routing.methods.exportActiveRoute.inputs.map((p) => p.name), ['referencingMethod']);
assert.strictEqual(routing.events.routeExported.outputs.find((p) => p.name === 'encodedRoute').dataRef, 'ByteBuffer');
const types = catalog.datatypes;
const ns = 'de.bmw.infotainment.navigation.';
assert.strictEqual(types[ns + 'RoutingTypes.ReferencingMethod'].items.POLYLINE, 3);
assert(types[ns + 'RoutingTypes2.RouteTripDefinition'].members.some((m) => m.name === 'routeIdentifer'));
assert(types[ns + 'GuidingTypes.DestinationInfo'].members.some((m) => m.name === 'isChargingStation'));
assert(types[ns + 'RoutingTypes.ERoutePreference'].members.some((m) => m.name === 'minSoCAtFinalDestination'));
console.log('Navegación: ' + Object.keys(expected).length + ' interfaces, herencia de listas, permisos por operación y contrato de ruta verificados.');
