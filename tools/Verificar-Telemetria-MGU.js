'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');
const { signals } = require('../apps/javi_carlauncher/telemetria-mgu.js');
const { service: tasu, instance: tasuInstance } = require('../apps/javi_carlauncher/potencia-hv.js');
const manifest = require('../apps/javi_carlauncher/package/manifest.json');

function verifyCatalog(catalog) {
    for (const [service, instance, fields] of signals) {
        const definition = catalog.interfaces[service];
        const instanceId = catalog.instanceIDs[service] && catalog.instanceIDs[service][instance];
        if (!definition || !Number.isInteger(instanceId)) {
            throw new Error('Falta la instancia ' + service + ' / ' + instance);
        }
        const attributes = {};
        for (const [name, [mode, ...paths]] of Object.entries(fields)) {
            const field = definition.fields[name];
            attributes[name] = mode;
            for (const access of mode) {
                const operation = field && field[access === 'r' ? 'getter' : 'notifier'];
                if (!operation || !Number.isInteger(operation.id) || operation.id <= 0) {
                    throw new Error('Falta la lectura de ' + service + '.' + name);
                }
            }
            for (const memberPath of paths) {
                let type = catalog.datatypes[field.dataRef];
                for (const member of memberPath.split('.')) {
                    const array = member.endsWith('[]');
                    const key = array ? member.slice(0, -2) : member;
                    const entry = type && type.members && type.members.find((item) => item.name === key);
                    if (!entry || Boolean(entry.dimension) !== array) {
                        throw new Error('Falta ' + memberPath + ' en ' + service + '.' + name);
                    }
                    type = catalog.datatypes[entry.dataRef];
                }
            }
        }
        assert.deepStrictEqual(manifest.proxies[service], { instances: [instance], attributes }, service);
    }
    const { methods, events } = catalog.interfaces[tasu];
    assert.strictEqual(catalog.instanceIDs[tasu][tasuInstance], 128);
    assert.strictEqual(methods.sendTasuRequest.methodId, 1);
    assert.strictEqual(events.sendTasuResponse.eventId, 32769);
    assert.deepStrictEqual(manifest.proxies[tasu], {
        instances: [tasuInstance], methods: ['sendTasuRequest'], broadcasts: ['sendTasuResponse']
    }, tasu);
}

function readCatalog(file) {
    const bytes = fs.readFileSync(file);
    if (path.extname(file) === '.json') return JSON.parse(bytes);
    const member = bytes.indexOf('/etc/oap/someip/someip-interfaces.json');
    if (member === -1) throw new Error('El paquete SWFL no contiene el catálogo SOME/IP');
    // Cabecera observada en SWFL 000056EE 036_010_004.
    return JSON.parse(zlib.inflateSync(bytes.subarray(member + 66), { maxOutputLength: 8 * 1024 * 1024 }));
}

const catalogPath = process.argv[2];
if (!catalogPath) throw new Error('Uso: node tools/Verificar-Telemetria-MGU.js <someip-interfaces.json o SWFL 000056EE>');
verifyCatalog(readCatalog(catalogPath));
console.log('Catálogo y permisos de lectura de telemetría verificados.');
