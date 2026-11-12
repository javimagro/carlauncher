'use strict';

const distanceUnits = { 1: 'km', 2: 'mi', KILOMETERS: 'km', MILES: 'mi' };
const consumptionUnits = { 1: 'kWh/100 km', 5: 'kWh/100 mi', KWH: 'kWh/100 km', KWH_100MI: 'kWh/100 mi' };
const thermalNames = [
    'NO_THERMAL_LIMITATIONS', 'THERMAL_LIMITATIONS_COLD', 'CONDITIONAL_THERMAL_LIMITATIONS_COLD',
    'THERMAL_LIMITATIONS_HOT', 'CONDITIONAL_THERMAL_LIMITATIONS_HOT'
];
const thermalLabels = [
    'Sin limitaciones', 'Limitación por frío', 'Limitación condicional por frío',
    'Limitación por calor', 'Limitación condicional por calor'
];
const valid = (raw, max) => Number.isInteger(raw) && raw >= 0 && raw <= max;

function staleSample(record, now) {
    return Number.isFinite(record.sampledAt) && Number.isFinite(record.freshForMs) &&
        now - record.sampledAt >= record.freshForMs;
}

function freshFields(records, signal, now) {
    const record = records && records.get(signal);
    return record && record.status === 'sample' && !staleSample(record, now) && record.fields || {};
}

function thermalStatus(value) {
    const index = Number.isInteger(value) ? value : thermalNames.indexOf(value);
    return thermalLabels[index];
}

function journeyReading(fields, period) {
    const distanceUnit = distanceUnits[fields['bcUnits.tachoDigital']];
    const averageUnit = consumptionUnits[fields['bcUnits.averageConsumptionElectric']];
    const distance = fields[period + '.counterDistance'];
    const average = fields[period + '.consumptionElectricAverageDigit'];
    const speed = fields[period + '.speedAverage'];
    const duration = ['day', 'hour', 'minute', 'second'].map((part) => fields[period + '.dateTimeTrip.' + part]);
    const [d, h, m, s] = duration;
    return {
        distanceUnit, averageUnit,
        distance: distanceUnit && valid(distance, 0xfffffffc) ? distance / 10 : undefined,
        average: averageUnit && valid(average, 0xfffffffc) ? (average - 65535) / 10 : undefined,
        speed: distanceUnit && valid(speed, 0xfffc) ? speed / 10 : undefined,
        duration: valid(d, 0xfffe) && valid(h, 23) && valid(m, 59) && valid(s, 59) ?
            d * 86400 + h * 3600 + m * 60 + s : undefined
    };
}

function vehicleReadings(records, now) {
    const field = (signal) => freshFields(records, signal, now);
    const battery = field('statusChargeOfBatteryHybrid').displayChargingConditionHighVoltageStorage;
    const range = field('displayRangeElectricVehicle').displayRangeElectricVehicle;
    const outside = field('ExteriorTemperature').temperatureExterior;
    const batteryTemperature = field('statusBatteryTemperature').actualValueTemperatureHighVoltageStorage;
    const speed = field('statusCarSpeed2').speedVehicleCentreOfGravity;
    const position = field('rawPositionData');
    const lat = position['position.latitude'];
    const lon = position['position.longitude'];
    const journey = field('bcDataAll');
    return {
        soc: valid(battery, 200) ? battery / 2 : undefined,
        range: valid(range, 4094) ? range : undefined,
        outside: valid(outside, 254) ? outside / 2 - 40 : undefined,
        batteryTemperature: valid(batteryTemperature, 254) ? batteryTemperature - 50 : undefined,
        speed: valid(speed, 0xfffe) ? speed / 64 : undefined,
        altitude: position['position.heightValid'] === true ? position['position.height.rawLengthMeter'] : undefined,
        location: position['position.coordinatesValid'] === true && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
            Number.isFinite(lon) && Math.abs(lon) <= 180 ? { latitude: lat, longitude: lon } : undefined,
        power: field('batteryPowerHv').kw,
        trip: journeyReading(journey, 'trip'),
        factory: journeyReading(journey, 'factory')
    };
}

module.exports = { vehicleReadings, journeyReading, staleSample, thermalStatus };
