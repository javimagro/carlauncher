'use strict';

// Hmi8 CNaviRouteInfo validates CHARGING_INFO percentages as integers <= 100.
// These are BMW predictions, never the configured minimum arrival preference.
const key = (r) => r && Number.isInteger(r.sessionID) && Number.isInteger(r.routeHandle)
    ? r.sessionID + ':' + r.routeHandle : null;
const percent = (v) => Number.isInteger(v) && v >= 0 && v <= 100 ? v : null;
const safe = (fn) => Promise.resolve().then(fn).catch(() => undefined);
function chargingValue(values) {
    const row = Array.isArray(values) && values.find((r) => r && [17, 'CHARGING_INFO'].includes(r.key));
    const info = row && row.value && row.value.chargingInfo;
    if (!info) return null;
    if (info.chargingStationInfo && !info.chargeStatus) return {
        charging: true, arrival: percent(info.chargingStationInfo.arrivalStateOfEnergy),
        departure: percent(info.chargingStationInfo.targetStateOfEnergy)
    };
    return info.chargeStatus && !info.chargingStationInfo
        ? { charging: false, arrival: percent(info.chargeStatus.estimatedStateOfEnergy), departure: null } : null;
}

function createEnergy(options) {
    options = options || {};
    const now = options.now || Date.now;
    let proxy, subscription, wanted, owner, closed = false, running = false, retryAt = 0;
    const records = new Map();
    function receive(e) {
        if (!owner || !wanted || owner.token !== wanted.token || key(e && e.routeIdentifier) !== key(owner.route) ||
            !Array.isArray(e.routeInfoList) || e.routeInfoList.length > 48) return;
        e.routeInfoList.forEach((r) => {
            if (!r || !wanted.ids.includes(r.tripSegmentID) ||
                (r.interpolationPointID !== undefined && r.interpolationPointID !== 0 && r.interpolationPointID !== '0') ||
                !Array.isArray(r.routeInfos) || r.routeInfos.length > 32 ||
                !r.routeInfos.some((v) => v && [17, 'CHARGING_INFO'].includes(v.key))) return;
            records.set(r.tripSegmentID, { value: chargingValue(r.routeInfos), at: now() });
        });
    }
    async function release() {
        const old = owner; owner = null; records.clear();
        if (old && proxy) await safe(() => proxy.stopRouteInfoUpdate({ routeIdentifier: old.route }, 4000));
    }
    async function pump() {
        if (running || !proxy) return;
        running = true;
        try {
            if (owner && (!wanted || owner.token !== wanted.token || closed)) await release();
            if (closed || !wanted || now() < retryAt) return;
            if (owner && now() - owner.requested < 20000) return;
            const context = wanted;
            owner = { token: context.token, route: context.route, requested: now(), accepted: false };
            const current = owner;
            const result = await proxy.requestRouteInfoUpdate({ routeIdentifier: current.route,
                tripSegmentUpdateSelection: 'ALL_SEGMENTS', routeInfoKeyList: ['CHARGING_INFO'], includeInterpolationPoints: false }, 4000);
            current.accepted = !!result && [0, 'NO_ERROR'].includes(result.RequestRouteInfoError);
            if (!current.accepted) { await release(); retryAt = now() + 10000; }
        } catch (_) { await release(); retryAt = now() + 10000; }
        finally {
            if (closed || owner && (!wanted || owner.token !== wanted.token)) {
                await release();
            }
            running = false;
            if (!closed && wanted && !owner && now() >= retryAt) pump();
        }
    }
    return {
        async attach(p) {
            if (closed) return;
            // An older app's restricted proxy may not expose these methods.
            if (!p.routeInfoUpdate || !p.requestRouteInfoUpdate || !p.stopRouteInfoUpdate) return;
            proxy = p;
            subscription = await p.routeInfoUpdate.subscribe(receive);
            if (closed) await safe(() => p.routeInfoUpdate.unsubscribe(subscription));
        },
        snapshot(route, trips, active) {
            const trip = active && key(route) && Array.isArray(trips) && trips.find((t) => t.active === true && key(t.routeIdentifer) === key(route));
            const segments = trip && trip.tripDefinition && trip.tripDefinition.tripSegment;
            const pending = Array.isArray(segments) && segments.length <= 24 ? segments.filter((s) =>
                s && [2, 4, 'ACTIVATED', 'UPCOMING'].includes(s.destinationStatus) && Number.isInteger(s.tripSegmentID)) : [];
            const ids = pending.map((s) => s.tripSegmentID);
            wanted = ids.length ? { route: { sessionID: route.sessionID, routeHandle: route.routeHandle }, ids,
                token: key(route) + '|' + ids.join(',') } : null;
            pump();
            if (!wanted || !owner || owner.token !== wanted.token || !owner.accepted) return null;
            function value(id) {
                const r = records.get(id);
                return r && now() >= r.at && now() - r.at <= 30000 ? r.value : null;
            }
            const final = value(ids[ids.length - 1]);
            let stop = null;
            for (const id of ids.slice(0, -1)) {
                const record = value(id);
                // A missing earlier segment may be the next charging stop.
                if (!record) break;
                if (record.charging) { stop = record; break; }
            }
            return { source: 'bmw', destinationSoc: final ? final.arrival : null,
                stopSoc: stop ? stop.arrival : null, chargedSoc: stop ? stop.departure : null };
        },
        async close() {
            closed = true; wanted = null; records.clear();
            if (proxy && subscription !== undefined) await safe(() => proxy.routeInfoUpdate.unsubscribe(subscription));
            // The proxy owner awaits this close before shutting down the proxy.
            while (running) await new Promise((resolve) => setTimeout(resolve, 20));
            await release();
        }
    };
}
module.exports = { createEnergy, chargingValue };
