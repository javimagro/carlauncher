'use strict';

// Local verification against the privately extracted catalog, never copy the catalog into the repo.
const fs = require('fs');
const assert = require('assert');
const { services, instance } = require('../apps/javi_carlauncher/navegacion-bmw');
const { contracts } = require('../apps/javi_carlauncher/navegacion-acciones');
const displayServices = require('../apps/javi_carlauncher/navegacion-pantallas').services;
const manifest = require('../apps/javi_carlauncher/package/manifest.json');
const catalog = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const expected = {};
function inherited(c, section, name) {
    return c && (c[section] && c[section][name] || c.extends && inherited(catalog.interfaces[c.extends], section, name));
}
for (const d of Object.keys(services).map((k) => services[k]).concat(Object.keys(contracts).map((k) => contracts[k]), Object.keys(displayServices).map((k) => displayServices[k]))) {
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
            assert(c.fields[name].getter && (!mode.includes('s') || c.fields[name].notifier) && (!mode.includes('w') || c.fields[name].setter), name);
            const combined = (permissions.attributes[name] || '') + mode;
            permissions.attributes[name] = 'rsw'.split('').filter((m) => combined.includes(m)).join('');
        }
    }
    if (d.methods) { permissions.methods = Array.from(new Set((permissions.methods || []).concat(d.methods))); d.methods.forEach((m) => assert(inherited(c, 'methods', m), d.name + '.' + m)); }
    if (d.broadcasts) { permissions.broadcasts = Array.from(new Set((permissions.broadcasts || []).concat(d.broadcasts))); d.broadcasts.forEach((e) => assert(inherited(c, 'events', e), e)); }
}
Object.keys(expected).forEach((name) => {
    if (name === displayServices.hud.name) { // Also used by vehicle telemetry.
        assert.deepStrictEqual(manifest.proxies[name].instances, expected[name].instances);
        Object.keys(expected[name].attributes).forEach((a) => assert.strictEqual(manifest.proxies[name].attributes[a], expected[name].attributes[a]));
    } else assert.deepStrictEqual(manifest.proxies[name], expected[name]);
});
const routing = catalog.interfaces[services.routing.name];
assert.deepStrictEqual(routing.methods.exportActiveRoute.inputs.map((p) => p.name), ['referencingMethod']);
assert.strictEqual(routing.events.routeExported.outputs.find((p) => p.name === 'encodedRoute').dataRef, 'ByteBuffer');
const types = catalog.datatypes;
const ns = 'de.bmw.infotainment.navigation.';
assert.strictEqual(types[ns + 'RoutingTypes.ReferencingMethod'].items.POLYLINE, 3);
assert(types[ns + 'RoutingTypes2.RouteTripDefinition'].members.some((m) => m.name === 'routeIdentifer'));
assert(types[ns + 'GuidingTypes.DestinationInfo'].members.some((m) => m.name === 'isChargingStation'));
assert(types[ns + 'RoutingTypes.ERoutePreference'].members.some((m) => m.name === 'minSoCAtFinalDestination'));
const poi = catalog.interfaces[contracts.poi.name], fts = catalog.interfaces[contracts.search.name];
function member(type, name) { return types[type].members.find((m) => m.name === name).dataRef; }
assert.strictEqual(poi.events.searchStatus.outputs.find((m) => m.name === 'searchState').dataRef, ns + 'POISearchTypes.SearchState');
assert.strictEqual(member(ns + 'POISearchTypes.SearchState', 'searchStatus'), ns + 'NaviCommonTypes.SearchStatus');
assert.strictEqual(fts.events.searchStatus.outputs.find((m) => m.name === 'searchState').dataRef, ns + 'NaviCommonTypes.SearchStatus');
assert.strictEqual(types[ns + 'NaviCommonTypes.SearchStatus'].items.FINISHED, 3);
assert.strictEqual(member(ns + 'POICategoryTreeTypes.POICategoryItem', 'categoryId'), ns + 'NavigationDataTypes.PoiCategoryId');
assert.strictEqual(types[ns + 'POISearchTypes.SpecialCategoryType'].items.CHARGING_STATION, 3);
assert.strictEqual(member(ns + 'POISearchTypes.POIResultList', 'poiResultElement'), ns + 'POISearchTypes.POIResultElement');
assert.strictEqual(types['de.bmw.infotainment.util.ListTypes.ListKey'].dataRef, 'UInt32');
const rendered = catalog.interfaces[displayServices.rendered.name], gt = ns + 'GuidingTypes.';
assert.deepStrictEqual(types[gt + 'DisplayType'].items, { CID: 1, HUD: 3, IC: 2, NONE: 0 });
const nativeTypes = require('../native/javi-carlab/navigation-displays').types;
Object.keys(nativeTypes).forEach((name, index) => assert.strictEqual(types[gt + 'RenderedContentType'].items[name], index));
for (const method of ['getViewConfig', 'getViewContent']) assert.deepStrictEqual(rendered.methods[method].inputs.map((p) => p.name), ['viewId']);
assert.strictEqual(member(gt + 'RenderedContentConfig', 'targetUI'), gt + 'DisplayType');
assert.strictEqual(member(gt + 'RenderedContent', 'configSequenceId'), gt + 'SequenceNumber');
assert.strictEqual(member(gt + 'RenderedContent', 'type'), gt + 'RenderedContentFullType');
assert.strictEqual(member(gt + 'RenderedContent', 'preview'), 'Bool');
const inf = 'de.bmw.infotainmenttypes.InfotainmentTypes.';
assert.strictEqual(catalog.interfaces[displayServices.hud.name].fields.statusHUDSelection.dataRef, inf + 'StatusHUDSelection2Wrapper');
assert.strictEqual(types[inf + 'StatusBacklightHUD3'].items.HUD_ANZEIGEBEREIT, 2);
assert.strictEqual(types[inf + 'StandscreenHUD'].items.NAVIGATIONSKARTE, 1);
console.log('Navegación: ' + Object.keys(expected).length + ' interfaces; permisos, ruta, HUD/cuadro, tipos de escena y secuencias verificados.');
