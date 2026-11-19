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
    sample(original, 61000, 360, 460);
    await original.close();
    assert.deepEqual(JSON.parse(await fs.readFile(file)).values, [440, 460], 'flush persists the latest snapshot');

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
