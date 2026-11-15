'use strict';

// Manual MGU21 probe: only availability/getters, no recording or recognition.
// Not installed by the BMWLauncher package. Requires explicit --read and SDK path.
const fs = require('fs');
const path = require('path');
const fields = ['availableUsecases', 'currentUsecase', 'intentsForApplications',
    'availableDictationLanguages', 'currentDictationLanguage', 'recognizerState'];
const contracts = [
    { key: 'recognizer2', name: 'de.bmw.infotainment.speech.recognizer2.Recognizer2', instance: 'PALSpeechHU',
        service: 63917, major: 1, minor: 0, fields, getters: [164, 167, 162, 161, 165, 169] },
    { key: 'recognizer', name: 'de.bmw.infotainment.speech.recognizer.Recognizer', instance: 'PALSpeechHU',
        service: 63908, major: 6, minor: 0, fields, getters: [28, 31, 96, 26, 29, 33] },
    { key: 'dialog', name: 'de.bmw.infotainment.speech.externaldialog2.ExternalDialogService2', instance: 'ExternalDialogService2HMI',
        service: 63920, major: 1, minor: 0, fields: ['currentApp'], getters: [158] },
    { key: 'projection', name: 'de.bmw.infotainment.sdi.projected.SpeechProjectedMode', instance: 'SpeechProjectedModeInst1',
        service: 64356, major: 0, minor: 1, fields: ['voiceAssistanceActive', 'alwaysOnMicAvailable'], getters: [4, 1] }
];

function verify(catalog) {
    const assert = require('assert');
    contracts.forEach((contract) => {
        const item = catalog.interfaces[contract.name];
        assert(item, contract.name);
        assert.strictEqual(item.serviceId, contract.service);
        assert.strictEqual(item.version.major, contract.major);
        assert.strictEqual(item.version.minor, contract.minor);
        assert.strictEqual(catalog.instanceIDs[contract.name][contract.instance], 128);
        contract.fields.forEach((name, i) => assert.strictEqual(item.fields[name].getter.id, contract.getters[i]));
    });
}

// Configs must come from this unit's catalog/generator, kept outside the repo.
// Expose only the verified getters even if a supplied config contains setters.
function nativeBuilders(someip, configs) {
    return { buildAndInitTypedProxy: async (name, instance, options) => {
        const contract = contracts.find((item) => item.name === name && item.instance === instance);
        const config = configs[name];
        if (!contract || !config || config.serviceId !== contract.service ||
            !config.version || config.version.major !== contract.major || config.version.minor !== contract.minor ||
            !config.instances || config.instances[instance] !== 128) throw new Error('contract');
        const read = { serviceId: contract.service, version: config.version, instances: {}, fields: {}, methods: {}, events: {} };
        read.instances[instance] = 128;
        contract.fields.forEach((field, index) => {
            const value = config.fields && config.fields[field];
            if (!value || !value.schema || !value.getter || value.getter.id !== contract.getters[index]) throw new Error('getter');
            read.fields[field] = { schema: value.schema, getter: { id: value.getter.id } };
            if (typeof value.getter.reliable === 'boolean') read.fields[field].getter.reliable = value.getter.reliable;
        });
        let proxy, timer;
        try {
            proxy = await someip.buildProxy(read, instance);
            await proxy.init();
            await Promise.race([proxy.waitUntilAvailable(), new Promise((resolve, reject) => {
                timer = setTimeout(() => reject(new Error('unavailable')), options.timeoutMs);
            })]);
            const typed = { shutdown: () => proxy.shutdown() };
            contract.fields.forEach((field) => { typed[field] = { getValue: (timeout) => proxy.getValue(field, timeout) }; });
            return typed;
        } catch (error) {
            if (proxy) { try { await proxy.shutdown(); } catch (_) {} }
            throw error;
        } finally { clearTimeout(timer); }
    } };
}

function bounded(value, depth) {
    if (typeof value === 'boolean' || Number.isFinite(value) && typeof value === 'number') return value;
    if (typeof value === 'string') return /^[A-Za-z0-9_.:-]{0,100}$/.test(value) ? value : '[omitted]';
    if (depth > 3 || !value) return null;
    if (Array.isArray(value)) return value.slice(0, 64).map((item) => bounded(item, depth + 1));
    const result = {};
    // Recognition rule metadata only; never transcripts, slots, vocabularies or arbitrary strings.
    ['intentgroupIdentifier', 'number', 'name', 'priority', 'languageCode'].forEach((key) => {
        if (Object.prototype.hasOwnProperty.call(value, key)) result[key] = bounded(value[key], depth + 1);
    });
    return result;
}

async function inspect(builders) {
    const report = { version: 1, recording: false, recognitionStarted: false, services: {} };
    for (const contract of contracts) {
        if (contract.key === 'recognizer' && report.services.recognizer2.available) continue;
        let proxy;
        const state = { available: false, fields: {} }; report.services[contract.key] = state;
        try {
            proxy = await builders.buildAndInitTypedProxy(contract.name, contract.instance, { timeoutMs: 2000 });
            state.available = true;
            for (const field of contract.fields) {
                try {
                    if (!proxy[field] || typeof proxy[field].getValue !== 'function') throw new Error('missing-getter');
                    const value = await proxy[field].getValue(1500);
                    state.fields[field] = field === 'currentApp' ? { active: typeof value === 'string' && !!value }
                        : { value: bounded(value, 0), limited: Array.isArray(value) && value.length > 64 };
                } catch (_) { state.fields[field] = { error: 'unavailable' }; }
            }
        } catch (_) { state.error = 'unavailable'; }
        finally {
            if (proxy && typeof proxy.shutdown === 'function') {
                try { await proxy.shutdown(); } catch (_) { state.closeError = true; }
            }
        }
    }
    return report;
}

async function main(args) {
    if (args.length === 2 && args[0] === '--verify') {
        verify(JSON.parse(fs.readFileSync(args[1], 'utf8')));
        fs.writeSync(1, 'Micrófono: cuatro contratos de consulta contrastados con el catálogo. Sin acceso al coche.\n');
        return;
    }
    if (args.length !== 3 || args[0] !== '--read' || args[1] !== '--sdk' || !path.isAbsolute(args[2])) {
        fs.writeSync(1, 'Solo lectura autorizada: node inspect-microphone.js --read --sdk /ruta/absoluta/someipBuilders.js\n' +
            'Verificación local: node inspect-microphone.js --verify RUTA_CATALOGO_PRIVADO\n');
        return;
    }
    const builders = require(args[2]);
    if (!builders || typeof builders.buildAndInitTypedProxy !== 'function') throw new Error('SDK');
    fs.writeSync(1, JSON.stringify(await inspect(builders), null, 2) + '\n');
}

if (require.main === module) {
    // A diagnostic must not keep its SDK processes alive indefinitely.
    const deadline = setTimeout(() => { fs.writeSync(2, 'Consulta agotada; no se ha iniciado grabación.\n'); process.exit(2); }, 45000);
    main(process.argv.slice(2)).then(() => {
        // someip.node can retain native handles after every proxy shutdown.
        clearTimeout(deadline); process.exit(0);
    }, () => {
        fs.writeSync(2, 'No se pudo completar la consulta del micrófono.\n');
        clearTimeout(deadline); process.exit(1);
    });
}
module.exports = { contracts, inspect, verify, nativeBuilders };
