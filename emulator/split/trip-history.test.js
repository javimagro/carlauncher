'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createTripHistory } = require('../../native/javi-carlab/trip-history');

function sample(history, at, duration, altitude) {
    history.sample({ trip: { duration }, altitude }, at);
}

test('an invalid GPS fix preserves height samples and a BMW trip reset starts a fresh history', () => {
    const history = createTripHistory();
    sample(history, 1000, 300, 440);
    sample(history, 26000, 325, undefined);
    sample(history, 46000, 345, 450);
    assert.deepEqual(history.values, [440]);
    sample(history, 61000, 360, 460);
    assert.deepEqual(history.values, [440, 460]);
    sample(history, 62000, 0, undefined);
    assert.deepEqual(history.values, []);
    sample(history, 66000, 4, 471);
    assert.deepEqual(history.values, [471]);
    for (let i = 1; i <= 400; i++) sample(history, 66000 + i * 60000, 4 + i * 60, 471 + i);
    assert.equal(history.values.length, 360);
    assert.equal(history.values.at(-1), 871);
});

test('height history resumes after a service restart only for the same boot and continuing native trip', async t => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'trip-history-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, 'history.json');
    const boot = async () => 'same-boot';
    const original = createTripHistory(file, boot);
    await original.ready;
    sample(original, 1000, 300, 440);
    original.sample({ trip: { duration: 360, distance: 6, speed: 60, average: 20, distanceUnit: 'km', averageUnit: 'kWh/100 km' },
        factory: { average: 18, averageUnit: 'kWh/100 km' }, altitude: 460 }, 61000);
    await original.close();
    const stored = JSON.parse(await fs.readFile(file));
    assert.deepEqual(stored.values, [440, 460]);
    assert.equal(stored.latest.summary.energy, 1.2);
    assert.equal(stored.latest.summary.historicalAverage, 18);
    assert.equal(stored.latest.summary.speed, 60);

    const afterRestart = createTripHistory(file, boot);
    await afterRestart.ready;
    sample(afterRestart, 62000, undefined, 900);
    assert.deepEqual(afterRestart.values, [], 'wait for a real trip counter before restoring');
    sample(afterRestart, 63000, 362, 470);
    assert.deepEqual(afterRestart.values, [440, 460]);
    sample(afterRestart, 121000, 420, 490);
    assert.deepEqual(afterRestart.values, [440, 460, 490]);
    await afterRestart.close();

    const checkpoint = await fs.readFile(file);

    const reset = createTripHistory(file, boot);
    await reset.ready;
    sample(reset, 122000, 1, undefined);
    assert.deepEqual(reset.values, []);
    await reset.close();
    assert.deepEqual(JSON.parse(await fs.readFile(file)).values, []);

    await fs.writeFile(file, checkpoint);
    const reboot = createTripHistory(file, async () => 'new-boot');
    await reboot.ready;
    sample(reboot, 122000, 421, undefined);
    assert.deepEqual(reboot.values, []);
    await reboot.close();
});

test('the elevation history keeps sampling valid fixes and clears when the distance resets', () => {
    const history = createTripHistory();
    const previous = { journeySampledAt: 1000, trip: { duration: 240, distance: 5, speed: 75, average: 20,
        distanceUnit: 'km', averageUnit: 'kWh/100 km' }, factory: { average: 18, averageUnit: 'kWh/100 km' },
        altitude: 450, outside: 12, batteryTemperature: 25 };
    history.sample(previous, 1000);
    const later = { ...previous, journeySampledAt: 61000, trip: { ...previous.trip, duration: 300, distance: 7, speed: 84, average: 22 },
        altitude: 470, outside: 13, batteryTemperature: 26 };
    history.sample(later, 61000);
    assert.deepEqual(history.values, [450, 470]);
    history.sample(later, 90000);
    assert.deepEqual(history.values, [450, 470]);
    history.sample({ ...later, trip: { ...later.trip, distance: 0 } }, 92000);
    assert.deepEqual(history.values, [470], 'a reset of BMW distance replaces the previous elevation series');
});
