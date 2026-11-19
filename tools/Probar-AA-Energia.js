'use strict';

const fs = require('fs');
const { createHash } = require('crypto');
const { vehicleReadings } = require('../native/javi-carlab/vehicle-readings');

// Offline compatibility probe. The Carlinkit asset is read from its own checkout.
function varint(value) {
    const bytes = [];
    while (value >= 128) {
        bytes.push(128 + value % 128);
        value = Math.floor(value / 128);
    }
    bytes.push(value);
    return Buffer.from(bytes);
}

function readVarint(bytes, start) {
    let value = 0;
    for (let offset = start; offset < bytes.length && offset < start + 10; offset++) {
        const byte = bytes[offset];
        value += (byte & 127) * Math.pow(128, offset - start);
        if (byte < 128) return { value, end: offset + 1 };
    }
    throw new Error('Varint de plantilla truncado o inválido');
}

function fields(bytes) {
    const result = [];
    let cursor = 0;
    while (cursor < bytes.length) {
        const tag = readVarint(bytes, cursor);
        if (tag.value >= 0x100000000) throw new Error('Etiqueta de plantilla inválida');
        const id = Math.floor(tag.value / 8), wire = tag.value % 8;
        let start = tag.end, end;
        if (wire === 0) end = readVarint(bytes, start).end;
        else if (wire === 1 || wire === 5) end = start + (wire === 1 ? 8 : 4);
        else if (wire === 2) {
            const size = readVarint(bytes, start);
            start = size.end;
            end = start + size.value;
        }
        if (!id || !Number.isSafeInteger(end) || end > bytes.length) throw new Error('Campo de plantilla inválido');
        result.push({ id, wire, raw: bytes.slice(cursor, end), data: bytes.slice(start, end) });
        cursor = end;
    }
    return result;
}

const scalar = (id, value) => Buffer.concat([varint(id * 8), varint(value)]);
const block = (id, data) => Buffer.concat([varint(id * 8 + 2), varint(data.length), data]);
const energy = (id, wh) => block(id, scalar(1, wh));
function float(id, value) {
    const data = Buffer.alloc(4);
    data.writeFloatLE(value, 0);
    return Buffer.concat([varint(id * 8 + 5), data]);
}

function replaceBlock(bytes, id, update) {
    const list = fields(bytes);
    const matches = list.filter(field => field.id === id && field.wire === 2);
    if (matches.length !== 1) throw new Error('Se esperaba un bloque ' + id + ' en la plantilla');
    return Buffer.concat(list.map(field => field === matches[0] ? block(id, update(field.data)) : field.raw));
}

function patchBattery(bytes, input) {
    // The two fields numbered 8 use different wire types in the Carlinkit model.
    const patches = new Map([
        ['3:2', energy(3, input.availableWh)], ['4:2', energy(4, input.capacityWh)],
        ['5:0', scalar(5, 0)], // HVAC unknown in the validated MGU input.
        ['6:5', float(6, 1.225)], ['7:5', input.outside === undefined ? null : float(7, input.outside)],
        ['8:5', input.batteryTemperature === undefined ? null : float(8, input.batteryTemperature)],
        ['8:2', energy(8, input.reserveWh)]
    ]);
    const parts = [], seen = new Set();
    for (const field of fields(bytes)) {
        const key = field.id + ':' + field.wire;
        if (!patches.has(key)) parts.push(field.raw);
        else {
            if (seen.has(key)) throw new Error('Campo de batería duplicado en la plantilla');
            seen.add(key);
            const patch = patches.get(key);
            if (patch) parts.push(patch);
        }
    }
    if (!seen.has('3:2') || !seen.has('4:2') || !seen.has('6:5')) {
        throw new Error('La estructura de batería no coincide con la plantilla de Carlinkit');
    }
    // Carlinkit adds temperature and reserve fields if its template lacks them.
    for (const key of ['8:5', '8:2']) {
        if (!seen.has(key) && patches.get(key)) parts.push(patches.get(key));
    }
    return Buffer.concat(parts);
}

function build(template, records, now, reservePercent) {
    if (!Buffer.isBuffer(template) || !template.length || template.length > 32768) throw new Error('Plantilla de modelo inválida');
    if (!Number.isInteger(reservePercent) || reservePercent < 0 || reservePercent > 30) throw new Error('Reserva fuera de 0–30 %');
    const reading = vehicleReadings(records, now);
    if (!reading.batteryEnergy) return null;
    const { capacityWh, availableWh } = reading.batteryEnergy;
    const percent = Math.round(100 * availableWh / capacityWh);
    const rangeKm = reading.range > 0 ? reading.range : undefined;
    const low = percent <= reservePercent;
    const state = { capacityWh, availableWh, percent, rangeKm, low, reserveWh: Math.round(capacityWh * reservePercent / 100),
        outside: reading.outside, batteryTemperature: reading.batteryTemperature };
    const fuelFields = [scalar(1, percent), scalar(3, Number(low))];
    if (rangeKm !== undefined) fuelFields.splice(1, 0, scalar(2, rangeKm));
    const fuel = block(6, Buffer.concat(fuelFields));
    const model = replaceBlock(template, 23, control => replaceBlock(control, 1, battery => patchBattery(battery, state)));
    return { state, fuel, model };
}

function demonstrationRecords(now) {
    const sample = fields => ({ status: 'sample', sampledAt: now, freshForMs: 60000, fields });
    return new Map([
        ['batteryEnergyHv', sample({ availableWh: 60500, capacityWh: 80700 })],
        ['displayRangeElectricVehicle', sample({ displayRangeElectricVehicle: 347 })],
        ['ExteriorTemperature', sample({ temperatureExterior: 70 })],
        ['statusBatteryTemperature', sample({ actualValueTemperatureHighVoltageStorage: 77 })]
    ]);
}

if (require.main === module) {
    try {
        const file = process.argv[2];
        if (!file) throw new Error('Uso: node tools/Probar-AA-Energia.js RUTA_JSON_CARLINKIT');
        if (fs.statSync(file).size > 131072) throw new Error('El JSON de Carlinkit supera 128 KiB');
        const { rawWireBytes } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof rawWireBytes !== 'string' || !/^(?:[\da-f]{2})+$/i.test(rawWireBytes)) throw new Error('Plantilla hexadecimal inválida');
        const now = Date.now();
        const result = build(Buffer.from(rawWireBytes, 'hex'), demonstrationRecords(now), now, 10);
        const report = { lectura: 'reproducción local', datos: result.state, sensor6: result.fuel.toString('hex'),
            sensor23: { bytes: result.model.length, sha256: createHash('sha256').update(result.model).digest('hex') } };
        console.log(JSON.stringify(report, null, 2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { build };
