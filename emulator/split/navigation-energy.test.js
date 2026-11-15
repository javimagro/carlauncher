'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEnergy, chargingValue } = require('../../apps/javi_carlauncher/navegacion-energia');
const { drawHome } = require('../../native/javi-carlab/drivehub-view');
const { validate } = require('../../native/javi-carlab/navigation-model');
const flush = () => new Promise((r) => setImmediate(r));
const route = { sessionID: 3, routeHandle: 2 };
const row = (value) => [{ key: 'CHARGING_INFO', value: { chargingInfo: value } }];
const trip = (ids) => [{ active: true, routeIdentifer: route, tripDefinition: {
    tripSegment: ids.map((tripSegmentID, i) => ({ tripSegmentID, destinationStatus: i ? 'UPCOMING' : 'ACTIVATED' }))
} }];

test('BMW energy keeps zero and percent units, and rejects sentinel or ambiguous union values', () => {
    assert.deepEqual(chargingValue(row({ chargeStatus: { estimatedStateOfEnergy: 0 } })), { charging: false, arrival: 0, departure: null });
    assert.deepEqual(chargingValue(row({ chargingStationInfo: { arrivalStateOfEnergy: 12, targetStateOfEnergy: 80 } })),
        { charging: true, arrival: 12, departure: 80 });
    for (const v of [101, 65535, -1, 0.5, '33', null]) assert.equal(chargingValue(row({ chargeStatus: { estimatedStateOfEnergy: v } })).arrival, null);
    assert.equal(chargingValue(row({ chargeStatus: {}, chargingStationInfo: {} })), null);
    assert.equal(chargingValue([{ key: 'ROUTE_OPTIONS', value: { minSoCAtFinalDestination: 10 } }]), null);
});

test('BMW energy follows all route segments, expires predictions and excludes passed stops', async (t) => {
    let callback, time = 1000; const calls = [], stops = [];
    const probe = createEnergy({ now: () => time }); t.after(() => probe.close());
    await probe.attach({ routeInfoUpdate: { async subscribe(fn) { callback = fn; return 1; }, async unsubscribe() {} },
        async requestRouteInfoUpdate(args) { calls.push(args); return { RequestRouteInfoError: 'NO_ERROR' }; },
        async stopRouteInfoUpdate(args) { stops.push(args); }
    });
    probe.snapshot(route, trip([6, 7, 8]), true); await flush();
    assert.equal(calls[0].tripSegmentUpdateSelection, 'ALL_SEGMENTS');
    callback({ routeIdentifier: route, routeInfoList: [
        { tripSegmentID: 7, interpolationPointID: '0', routeInfos: row({ chargingStationInfo: { arrivalStateOfEnergy: 12, targetStateOfEnergy: 80 } }) },
        { tripSegmentID: 8, interpolationPointID: '0', routeInfos: row({ chargeStatus: { estimatedStateOfEnergy: 28 } }) }
    ] });
    assert.equal(probe.snapshot(route, trip([6, 7, 8]), true).stopSoc, null);
    assert.equal(probe.snapshot(route, trip([6, 7, 8]), true).destinationSoc, 28);
    callback({ routeIdentifier: route, routeInfoList: [{ tripSegmentID: 6, routeInfos:
        row({ chargeStatus: { estimatedStateOfEnergy: 40 } }) }] });
    assert.equal(probe.snapshot(route, trip([6, 7, 8]), true).stopSoc, 12);
    probe.snapshot(route, trip([7, 8]), true); await flush();
    callback({ routeIdentifier: route, routeInfoList: [
        { tripSegmentID: 7, interpolationPointID: '0', routeInfos: row({ chargingStationInfo: { arrivalStateOfEnergy: 12, targetStateOfEnergy: 80 } }) },
        { tripSegmentID: 8, interpolationPointID: '0', routeInfos: row({ chargeStatus: { estimatedStateOfEnergy: 28 } }) }
    ] });
    assert.deepEqual(probe.snapshot(route, trip([7, 8]), true), { source: 'bmw', destinationSoc: 28, stopSoc: 12, chargedSoc: 80 });
    callback({ routeIdentifier: { sessionID: 9, routeHandle: 1 }, routeInfoList: [{ tripSegmentID: 8, routeInfos: row({ chargeStatus: { estimatedStateOfEnergy: 99 } }) }] });
    assert.equal(probe.snapshot(route, trip([7, 8]), true).destinationSoc, 28);
    time += 30001; probe.snapshot(route, trip([7, 8]), true); await flush();
    assert.equal(probe.snapshot(route, trip([7, 8]), true).destinationSoc, null);
    const next = trip([7, 8]); next[0].tripDefinition.tripSegment[0].destinationStatus = 'PASSED';
    assert.equal(probe.snapshot(route, next, true), null); await flush();
    callback({ routeIdentifier: route, routeInfoList: [{ tripSegmentID: 7, routeInfos: row({ chargingStationInfo: { arrivalStateOfEnergy: 12, targetStateOfEnergy: 80 } }) }] });
    assert.equal(probe.snapshot(route, next, true).stopSoc, null);
    assert.equal(probe.snapshot(route, next, false), null); await flush();
    assert(stops.length >= 2);
});

test('hiding while BMW accepts an energy request releases only that read subscription', async () => {
    let resolve, stopped = 0, unsubscribed = 0;
    const probe = createEnergy();
    await probe.attach({ routeInfoUpdate: { async subscribe() { return 9; }, async unsubscribe(id) { assert.equal(id, 9); unsubscribed++; } },
        requestRouteInfoUpdate() { return new Promise((r) => { resolve = r; }); },
        async stopRouteInfoUpdate(args) { assert.deepEqual(args.routeIdentifier, route); stopped++; }
    });
    probe.snapshot(route, trip([1]), true);
    const closing = probe.close(); resolve({ RequestRouteInfoError: 'NO_ERROR' }); await closing;
    assert.equal(stopped, 1); assert.equal(unsubscribed, 1);
});

test('energy bar draws BMW arrival including zero, no demo forecast, and removes it when guidance stops', () => {
    const labels = [], cv = new Proxy({ text(v) { labels.push(v); }, textWidth: (s, size) => String(s).length * size * .45 }, { get: (o, k) => o[k] || (() => {}) });
    const data = { energy: ['Ahora', 'En la parada', 'Tras recarga', 'En destino'].map((label) => ({ label, soc: 88, range: 400 })),
        diagnostics: true, navigation: { state: 'active', destinations: [], energy: { source: 'bmw', destinationSoc: 0, stopSoc: null, chargedSoc: null } } };
    drawHome(cv, { selected: 0, article: 0 }, 0, data, () => 1, 1000);
    assert(labels.includes('0%')); assert(labels.includes('En destino')); assert(!labels.includes('En la parada'));
    assert(!labels.includes('88%')); assert(!labels.includes('400 km'));
    labels.length = 0; data.navigation.state = 'inactive';
    drawHome(cv, { selected: 0, article: 0 }, 0, data, () => 1, 1000);
    assert(!labels.includes('0%')); assert(!labels.includes('En destino'));
    const frame = { version: 1, at: 1, state: 'active', theme: 'auto', route: null, destinations: [], destinationsKnown: true,
        segments: [], electricRouting: true, energy: { source: 'bmw', destinationSoc: 101, stopSoc: null, chargedSoc: null } };
    assert.equal(validate(frame), false); frame.energy.destinationSoc = 0; assert.equal(validate(frame), true);
});
