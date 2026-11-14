'use strict';

// Commands use private search/routing sessions. Opening a panel never changes guidance.
const ns = 'de.bmw.infotainment.navigation.';
const contracts = {
    search: { name: ns + 'freetextsearch.FreeTextSearch', methods: ['createSession', 'deleteSession', 'setCCPLocation', 'startSearch', 'cancelSearch', 'getValidatedLocation', 'createViewByIndex', 'destroyView'], broadcasts: ['resultList', 'searchStatus', 'changedViewInfo'] },
    poi: { name: ns + 'poisearch.POISearch', methods: ['createPOISearchSession', 'deletePOISearchSession', 'setCCPLocation', 'setCategories', 'setSearchConfiguration', 'startPOISearch', 'cancelPOISearch', 'getPOIDetail', 'createViewByIndex', 'destroyView'], broadcasts: ['resultList', 'searchStatus', 'changedViewInfo'] },
    categories: { name: ns + 'poicategorytree.POICategoryTree', attributes: { specialCategoryList: 'r' } },
    routing: { name: ns + 'routing.Routing', methods: ['createRoutingSession', 'deleteSession', 'calculateRoute', 'getTripDefinition', 'requestRouteInfoUpdate', 'stopRouteInfoUpdate'], attributes: { userCommonOptions: 'r', routeSummary: 'r' }, broadcasts: ['routeInfoUpdate'] },
    trips: { name: ns + 'routing2.Routing2', attributes: { currentTrips: 'r' } },
    guidance: { name: ns + 'guiding.Guidance', methods: ['startGuidance', 'stopGuidance'], attributes: {
        junction3dViewInKombiEnabled: 'rw', visualizationInKombiNonNaviEnabled: 'rw',
        additionalInformationEnabled: 'rw', guidingPopupsEnabled: 'rw', signboardPopupsEnabled: 'rw'
    } }
};
const clean = (s) => typeof s === 'string' ? s.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 140) : '';
const clone = (v) => JSON.parse(JSON.stringify(v, (key, item) => key === 'internalData' && item instanceof Uint8Array ?
    { type: 'Buffer', data: Array.from(item) } : item), (key, item) => {
    if (key === 'internalData' && item && item.type === 'Buffer' && Array.isArray(item.data) && item.data.length <= 24000 &&
        item.data.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) return Buffer.from(item.data);
    return item;
});
const ignore = (fn) => Promise.resolve().then(fn).catch(() => {});
function metres(distance) { return distance && Number.isFinite(distance.rawLengthMeter) && distance.rawLengthMeter >= 0 ? distance.rawLengthMeter : null; }
function seconds(value) {
    const factor = { 1: 0.001, 2: 1, 3: 60, 4: 3600, MILLISECONDS: 0.001, SECONDS: 1, MINUTES: 60, HOURS: 3600 };
    return value && Number.isFinite(value.duration) && value.duration >= 0 && factor[value.timebase] ? value.duration * factor[value.timebase] : null;
}
function checked(result) {
    if (!result || typeof result !== 'object') throw new Error('BMW_RESPONSE');
    Object.keys(result).filter((k) => /Error$|^InvalidListKey$/.test(k)).forEach((k) => {
        if (![0, 'NO_ERROR', 'OK'].includes(result[k])) throw new Error(k + ':' + result[k]);
    });
    return result;
}
function location(union) {
    const p = union && (union.optionPOILocation || union.optionLocation || union.contactLocation);
    return p && p.coordinatesValid === true && Number.isFinite(p.latitude) && Math.abs(p.latitude) <= 90 &&
        Number.isFinite(p.longitude) && Math.abs(p.longitude) <= 180 ? p : null;
}
function resultLabel(row) {
    if (row.poiName) return clean(row.poiName);
    const values = (row.textDescription || row.highlightTextDescription || {}).textDescription || {};
    const entries = Object.keys(values).map((k) => clean(values[k] && values[k].text && values[k].text.orthography)).filter(Boolean);
    return entries.filter((v, i) => entries.indexOf(v) === i).join(', ').slice(0, 140) || clean(row.takeoverSearchString);
}
function routeOptions(base, prefs) {
    if (!base || !base.eRoutePreference || !Array.isArray(base.routePreferences)) throw new Error('BMW_ROUTE_OPTIONS');
    const options = clone(base);
    if (prefs) {
        if (typeof prefs.charging === 'boolean') options.eRoutePreference.eRoutesOn = prefs.charging;
        if (Number.isInteger(prefs.arrival) && prefs.arrival >= 5 && prefs.arrival <= 50) options.eRoutePreference.minSoCAtFinalDestination = prefs.arrival;
        [['tolls', 3, 'TOLLROADS'], ['motorways', 1, 'MOTORWAY']].forEach(([name, id, type]) => {
            if (typeof prefs[name] !== 'boolean') return;
            options.routePreferences = options.routePreferences.filter((p) => p.type !== id && p.type !== type);
            options.routePreferences.push({ type, action: prefs[name] ? 'USE' : 'AVOID' });
        });
    }
    return options;
}
function tripDefinition(stops, options) {
    return { tripHeader: { tripId: 0, tripType: 'TRIP', tripTextDescription: 'BMWLauncher', readingData: '' },
        tripSegment: stops.map((stop, i) => ({ tripSegmentID: i + 1,
            destinationType: i === stops.length - 1 ? 'DESTINATION' : 'HARD_VIAPOINT', destinationStatus: 'ACTIVATED',
            destination: stop.address, interpolationPointList: [], routeOptions: clone(options), isERouteTripSegment: false })) };
}
function tripStops(definition) {
    const list = definition && definition.tripSegment;
    if (!Array.isArray(list)) return [];
    return list.slice(0, 24).map((s) => {
        const point = location(s.destination);
        if (!point) return null;
        const names = point.textDescription && point.textDescription.textDescriptorList || {};
        const first = names.LOCATION_NAME || names['1'] || names.FULL_ADDRESS || names['2'];
        return { name: clean(point.name || first && first.orthography || 'Destino BMW'), address: s.destination,
            latitude: point.latitude, longitude: point.longitude, charging: s.isERouteTripSegment === true };
    }).filter(Boolean);
}

function createActions(builders, options) {
    options = options || {};
    const now = options.now || Date.now;
    const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const proxies = {}, subscriptions = [];
    let closed = false, busy = false, generation = 0, search, selected, plan, routeSession, closing;
    let stops = [], rows = [], categoryIds = [];
    let state = { status: 'idle', request: 0, query: '', results: [], selected: null, stops: [], plan: null, error: '', searchPhase: 'idle' };
    const update = (values) => { if (!closed) state = Object.assign({}, state, values); };
    async function proxy(key) {
        if (!proxies[key]) proxies[key] = builders.buildAndInitTypedProxy(contracts[key].name, 'Main_Instance', { timeoutMs: 10000 })
            .catch((error) => { delete proxies[key]; throw error; });
        const p = await proxies[key];
        if (closed) { if (p.dispose) ignore(() => p.dispose()); throw new Error('CLOSED'); }
        return p;
    }
    function alive(token) { if (closed || token !== generation) throw new Error('CANCELLED'); }
    async function call(p, method, args) { return checked(await p[method](args || {})); }
    async function clearSearch() {
        const old = search; search = null; rows = [];
        if (!old) return;
        if (old.view) await ignore(() => old.p.destroyView({ view: old.view }));
        await ignore(() => old.p[old.poi ? 'cancelPOISearch' : 'cancelSearch']({ sessionID: old.id }));
        await ignore(() => old.p[old.poi ? 'deletePOISearchSession' : 'deleteSession']({ sessionID: old.id }));
        subscriptions.splice(0).forEach(([event, id]) => ignore(() => event.unsubscribe(id)));
    }
    async function clearPlan() {
        const old = routeSession; routeSession = null; plan = null;
        update({ plan: null });
        if (old && old.infoSubscription !== undefined) {
            await ignore(() => old.p.routeInfoUpdate.unsubscribe(old.infoSubscription));
            if (old.route) await ignore(() => old.p.stopRouteInfoUpdate({ routeIdentifier: old.route }));
        }
        if (old && !old.started) await ignore(() => old.p.deleteSession({ sessionID: old.id }));
    }
    function finishClose() {
        if (closing) return closing;
        closing = Promise.resolve().then(clearSearch).then(clearPlan).then(() => Promise.all(Object.keys(proxies).map((key) =>
            proxies[key].then((p) => p.dispose && ignore(() => p.dispose()), () => {}))));
        return closing;
    }
    function detail(owner, row) {
        const key = String(row.key);
        if (!owner.details[key]) owner.details[key] = call(owner.p, owner.poi ? 'getPOIDetail' : 'getValidatedLocation',
            owner.poi ? { poiID: row.poiID } : { sessionID: owner.id, key: row.key }).catch((error) => {
            delete owner.details[key]; throw error;
        });
        return owner.details[key];
    }
    async function locateResults(owner) {
        // One background lookup; selecting the same row shares its pending call.
        // Never let late coordinates replace a newer list, detail or route.
        if (!owner || owner.locating || busy || closed || search !== owner || owner.destroyed) return;
        const row = rows.find((r) => !owner.attempted[r.key]);
        if (!row || owner.lookups >= 64) return;
        owner.locating = true; owner.attempted[row.key] = true; owner.lookups++;
        const identity = row.poiID && JSON.stringify(row.poiID);
        try {
            const result = await detail(owner, row);
            if (closed || search !== owner || owner.destroyed) return;
            const current = rows.find((r) => r.key === row.key);
            if (!current || (current.poiID && JSON.stringify(current.poiID)) !== identity) return;
            const point = location(result.address || result.validatedLocation);
            update({ results: state.results.map((r) => r.id !== owner.id + ':' + row.key ? r : Object.assign({}, r,
                point ? { latitude: point.latitude, longitude: point.longitude, positionState: 'ready' } : { positionState: 'unavailable' })) });
        } catch (_) {
            if (!closed && search === owner && !owner.destroyed) update({ results: state.results.map((r) =>
                r.id === owner.id + ':' + row.key ? Object.assign({}, r, { positionState: 'unavailable' }) : r) });
        } finally {
            owner.locating = false;
            if (!closed && search === owner) locateResults(owner);
        }
    }
    function receiveResults(owner, event) {
        if (closed || search !== owner || owner.destroyed || !event || !event.viewUpdateInfo) return;
        const view = event.viewUpdateInfo.viewId;
        if (!view || view.listname !== String(owner.id) || (owner.view && view.view !== owner.view.view)) return;
        const list = event.resultList;
        if (owner.poi && (!list || list.sessionID !== owner.id)) return;
        const entries = list && (owner.poi ? list.poiResultElement : list.resultListElements);
        if (!Array.isArray(entries)) return;
        const previous = rows;
        rows = entries.slice(0, 32).filter((r) => r && Number.isInteger(r.key));
        Object.keys(owner.details).forEach((key) => {
            if (!rows.some((r) => String(r.key) === key)) { delete owner.details[key]; delete owner.attempted[key]; }
        });
        const values = { results: rows.map((r) => {
            const oldRow = previous.find((p) => p.key === r.key);
            const same = oldRow && JSON.stringify(oldRow.poiID) === JSON.stringify(r.poiID);
            const old = same && state.results.find((p) => p.id === owner.id + ':' + r.key);
            if (!same) { delete owner.details[r.key]; delete owner.attempted[r.key]; }
            return Object.assign({}, old || {}, { id: String(owner.id) + ':' + r.key, name: resultLabel(r),
            metres: metres(r.distanceToEntry || r.distanceToPOI),
            type: owner.poi ? 'charger' : [2, 'POI'].includes(r.type) ? 'poi' : 'address', positionState: old && old.positionState || 'pending' });
        }) };
        // Search notifications can keep arriving while detail or routing owns the UI.
        if (state.request === owner.request) {
            values.status = rows.length || !owner.waiting ? 'results' : 'loading';
            values.searchPhase = owner.waiting ? 'results' : 'finished';
            values.error = '';
        }
        update(values);
        locateResults(owner);
    }
    function receiveSearchStatus(owner, value) {
        if (closed || search !== owner || owner.destroyed || !value || value.sessionID !== owner.id) return;
        // Unlike FTS, POISearch publishes a SearchState struct, not the enum itself.
        const status = owner.poi ? value.searchState && value.searchState.searchStatus : value.searchState;
        if (![3, 'FINISHED'].includes(status)) return;
        if (owner.waiting) owner.finishedAt = now();
        owner.waiting = false;
        if (state.request === owner.request) update({ status: owner.listSize > 0 && !rows.length ? 'loading' : 'results', searchPhase: 'finished' });
    }
    function receiveViewInfo(owner, value) {
        if (closed || search !== owner || owner.destroyed || !value) return;
        const info = value.view_update, list = value.list_update, view = info && info.view;
        if (!view || view.listname !== String(owner.id) || owner.view && view.view !== owner.view.view ||
            !list || !list.list || list.list.listname !== String(owner.id)) return;
        if ([5, 'DESTROYED'].includes(value.operation)) {
            owner.waiting = false; owner.destroyed = true; rows = [];
            if (state.request === owner.request) update({ status: 'error', error: 'BMW_LIST_DESTROYED', results: [] });
        } else if (Number.isInteger(list.size) && list.size >= 0 && list.size <= 0xffffffff) {
            owner.listSize = list.size;
            if (state.request === owner.request && !owner.waiting && !rows.length && list.size > 0) update({ status: 'loading' });
        }
    }
    async function startSearch(command, token) {
        await clearSearch(); alive(token);
        const isPoi = command.action === 'chargers';
        update({ searchPhase: 'session' });
        const p = await proxy(isPoi ? 'poi' : 'search'); alive(token);
        const result = await call(p, isPoi ? 'createPOISearchSession' : 'createSession');
        if (!Number.isInteger(result.sessionID)) throw new Error('BMW_SESSION');
        const owner = { p, id: result.sessionID, poi: isPoi, request: command.request, view: null, at: now(), waiting: true,
            details: Object.create(null), attempted: Object.create(null), locating: false, lookups: 0 };
        search = owner; alive(token);
        for (const name of ['resultList', 'searchStatus', 'changedViewInfo']) {
            const event = p[name];
            const id = await event.subscribe((value) => {
                if (name === 'resultList') receiveResults(owner, value);
                else if (name === 'searchStatus') receiveSearchStatus(owner, value);
                else receiveViewInfo(owner, value);
            });
            subscriptions.push([event, id]); alive(token);
        }
        update({ searchPhase: 'location' });
        await call(p, 'setCCPLocation', { sessionID: owner.id }); alive(token);
        if (isPoi) {
            update({ searchPhase: 'categories' });
            const c = await proxy('categories');
            const list = await c.specialCategoryList.getValue(); alive(token);
            const group = Array.isArray(list) && list.find((g) => [3, 'CHARGING_STATION'].includes(g.type));
            categoryIds = group && Array.isArray(group.categories) ? group.categories.map((g) => g.categoryId) : [];
            if (!categoryIds.length) throw new Error('BMW_CHARGER_CATEGORY');
            await call(p, 'setCategories', { sessionID: owner.id, categoryList: categoryIds, excludedCategoryList: [] }); alive(token);
            await call(p, 'setSearchConfiguration', { sessionID: owner.id, searchRadius: 50000, maxNumberOfResult: 32 }); alive(token);
            update({ searchPhase: 'search' });
            await call(p, 'startPOISearch', { sessionID: owner.id, inputString: '' });
        } else {
            update({ searchPhase: 'search' });
            await call(p, 'startSearch', { sessionID: owner.id, inputString: command.query, nvc: false,
                filterAddressLevel: [], filterDataType: ['ADDRESS', 'POI'], filterDataSource: [] });
        }
        alive(token);
        // Hmi8 CNaviSearchSession's list-name getter formats its UInt32 session as "%u".
        update({ searchPhase: 'view' });
        const view = await call(p, 'createViewByIndex', { list: { listname: String(owner.id) }, viewsize: 32, position: 0, policy: 'START', offset: 0 });
        owner.view = view.view; alive(token);
        if (!owner.view || owner.view.listname !== String(owner.id) || !Number.isInteger(owner.view.view)) throw new Error('BMW_LIST_VIEW');
        update({ searchPhase: owner.waiting ? 'results' : 'finished' });
    }
    async function choose(command, token) {
        selected = null; update({ selected: null });
        const owner = search;
        const row = owner && rows.find((r) => String(owner.id) + ':' + r.key === command.id);
        if (!row) throw new Error('RESULT_EXPIRED');
        const result = await detail(owner, row);
        alive(token);
        const address = result.address || result.validatedLocation;
        const point = location(address);
        if (!point) throw new Error('BMW_DESTINATION');
        selected = { name: resultLabel(row), address, latitude: point.latitude, longitude: point.longitude };
        const info = result.detail && result.detail.details;
        update({ status: 'detail', selected: { id: command.id, type: owner.poi ? 'charger' : [2, 'POI'].includes(row.type) ? 'poi' : 'address',
            metres: metres(row.distanceToEntry || row.distanceToPOI), name: selected.name, latitude: point.latitude, longitude: point.longitude,
            address: Buffer.byteLength(JSON.stringify(address)) <= 24000 ? clone(address) : null,
            phone: clean(result.detail && result.detail.telefonNumber),
            details: Array.isArray(info) ? info.filter((r) => r.isDisplayable === true && r.value && typeof r.value.stringValue === 'string')
                .slice(0, 3).map((r) => clean(r.value.stringValue)) : [] } });
    }
    async function calculate(command, token) {
        if (!selected && !stops.length) throw new Error('NO_DESTINATION');
        if (command.action === 'add-stop') {
            if (!selected || stops.length >= 12) throw new Error('STOP_LIMIT');
            // Insert before the final destination; manual stops are not automatic charging stops.
            stops.splice(Math.max(0, stops.length - 1), 0, selected);
        } else if (command.action === 'route') stops = [selected];
        await clearPlan(); alive(token);
        const p = await proxy('routing');
        const prefs = routeOptions(await p.userCommonOptions.getValue(), command.preferences); alive(token);
        const created = await call(p, 'createRoutingSession', { tripDefinition: tripDefinition(stops, prefs) });
        if (!Number.isInteger(created.sessionID)) throw new Error('BMW_SESSION');
        routeSession = { p, id: created.sessionID, started: false }; alive(token);
        const result = await call(p, 'calculateRoute', { sessionID: created.sessionID }); alive(token);
        if (!result.routeIdentifier || result.routeIdentifier.sessionID !== created.sessionID || !Number.isInteger(result.routeIdentifier.routeHandle)) throw new Error('BMW_ROUTE');
        const owner = routeSession; owner.route = result.routeIdentifier;
        const deadline = now() + 60000;
        while (now() < deadline) {
            const summary = await p.routeSummary.getValue(); alive(token);
            const group = Array.isArray(summary) && summary.find((s) => s.sessionID === created.sessionID);
            const item = group && Array.isArray(group.routeSummaryElementList) && group.routeSummaryElementList.find((r) => r.routeIdentifier.routeHandle === result.routeIdentifier.routeHandle);
            const progress = item && item.routeStatus && item.routeStatus.routeCalculationStatus && item.routeStatus.routeCalculationStatus.calculationProgress;
            if ([5, 'CALCULATION_FAILED'].includes(progress)) throw new Error('BMW_CALCULATION');
            if (item && item.validity === true && [4, 'ROUTE_FULLY_AVAILABLE'].includes(progress)) {
                plan = { route: result.routeIdentifier, options: prefs };
                let displayStops = stops;
                try { const trip = await call(p, 'getTripDefinition', { sessionID: created.sessionID }); alive(token); const found = tripStops(trip.tripDefinition); if (found.length) displayStops = found; } catch (_) { alive(token); }
                owner.displayStops = displayStops;
                update({ status: 'preview', plan: { key: result.routeIdentifier.sessionID + ':' + result.routeIdentifier.routeHandle,
                    charging: prefs.eRoutePreference.eRoutesOn, arrival: prefs.eRoutePreference.minSoCAtFinalDestination },
                    stops: displayStops.map((s) => ({ name: s.name, latitude: s.latitude, longitude: s.longitude, charging: s.charging === true })) });
                try {
                    owner.infoSubscription = await p.routeInfoUpdate.subscribe((event) => {
                        if (closed || routeSession !== owner || !state.plan || !event || !Array.isArray(event.routeInfoList)) return;
                        const info = event.routeInfoList.find((e) => e.routeIdentifier && e.routeIdentifier.sessionID === owner.id && e.routeIdentifier.routeHandle === owner.route.routeHandle);
                        const value = info && Array.isArray(info.routeInfos) && info.routeInfos.find((r) => [1, 'ROUTE_INFO'].includes(r.key));
                        const section = value && value.value && value.value.sectionInfo;
                        const length = section && metres(section.length), duration = section && seconds(section.duration);
                        if (length !== null && duration !== null && length < 50000000 && duration < 604800)
                            update({ plan: Object.assign({}, state.plan, { metres: length, seconds: duration }) });
                    }); alive(token);
                    await call(p, 'requestRouteInfoUpdate', { useNextDestination: false, routeIdentifier: owner.route, routeInfoKeyList: ['ROUTE_INFO'] }); alive(token);
                } catch (_) { alive(token); }
                return;
            }
            await sleep(1000); alive(token);
        }
        throw new Error('BMW_CALCULATION_TIMEOUT');
    }
    return {
        snapshot() {
            if (search && search.waiting && !busy && now() - search.at > 30000 && state.status === 'loading') update({ status: 'error', error: 'BMW_SEARCH_TIMEOUT' });
            if (search && state.request === search.request && !busy && !search.waiting && !search.destroyed &&
                search.listSize > 0 && !rows.length && now() - search.finishedAt > 5000) update({ status: 'error', error: 'BMW_LIST_NOT_RECEIVED' });
            return Object.assign({}, state, { busy });
        },
        async command(command) {
            if (closed || busy || !command || !Number.isInteger(command.request) || command.request <= state.request) return;
            const action = command.action;
            if (!['search', 'chargers', 'select', 'restore', 'route', 'add-stop', 'recalculate', 'start', 'stop', 'cancel', 'itinerary', 'guidance-setting'].includes(action)) return;
            if (action === 'search' && (typeof command.query !== 'string' || !command.query.trim() || command.query.length > 140)) return;
            if (action === 'guidance-setting' && (!Object.prototype.hasOwnProperty.call(contracts.guidance.attributes, command.setting) || typeof command.enabled !== 'boolean')) return;
            const token = ++generation; busy = true;
            update({ request: command.request, error: '', status: action === 'guidance-setting' ? state.status : ['route', 'add-stop', 'recalculate'].includes(action) ? 'calculating' : 'loading' });
            try {
                if (action === 'guidance-setting') {
                    const p = await proxy('guidance'); alive(token);
                    const attribute = p[command.setting];
                    if (!attribute || typeof attribute.setValue !== 'function') throw new Error('BMW_GUIDANCE_SETTING_UNAVAILABLE');
                    // Explicit individual preference change. No startup writes, batch enabling or retry.
                    await attribute.setValue(command.enabled); alive(token);
                    if (await attribute.getValue() !== command.enabled) throw new Error('BMW_GUIDANCE_SETTING_REJECTED');
                    alive(token);
                } else if (action === 'search' || action === 'chargers') {
                    selected = null;
                    update({ query: action === 'chargers' ? 'Cargadores cercanos' : clean(command.query), results: [], selected: null });
                    await startSearch(command, token);
                } else if (action === 'select') await choose(command, token);
                else if (action === 'restore') {
                    const bookmark = command.bookmark, point = bookmark && location(bookmark.address);
                    if (!point || typeof bookmark.name !== 'string' || Buffer.byteLength(JSON.stringify(bookmark.address)) > 24000) throw new Error('INVALID_SAVED_DESTINATION');
                    selected = { name: clean(bookmark.name), address: clone(bookmark.address), latitude: point.latitude, longitude: point.longitude };
                    update({ status: 'detail', selected: { name: selected.name, address: selected.address, latitude: point.latitude, longitude: point.longitude, phone: '', details: [] } });
                }
                else if (action === 'itinerary') {
                    let displayStops = routeSession && routeSession.displayStops || stops;
                    if (!stops.length) {
                        const p = await proxy('trips'); const trips = await p.currentTrips.getValue(); alive(token);
                        const activeTrip = Array.isArray(trips) && trips.find((t) => t.active === true);
                        displayStops = activeTrip ? tripStops(activeTrip.tripDefinition) : [];
                        stops = displayStops.filter((s) => !s.charging).slice(0, 12);
                    }
                    update({ status: plan ? 'preview' : 'results', stops: displayStops.map((s) => ({ name: s.name, latitude: s.latitude, longitude: s.longitude, charging: s.charging === true })) });
                }
                else if (['route', 'add-stop', 'recalculate'].includes(action)) await calculate(command, token);
                else if (action === 'start') {
                    if (!plan || !routeSession) throw new Error('NO_ROUTE');
                    const p = await proxy('guidance'); alive(token);
                    await call(p, 'startGuidance', { route: plan.route });
                    routeSession.started = true; update({ status: 'guiding' });
                } else if (action === 'stop') {
                    const p = await proxy('guidance'); alive(token);
                    await call(p, 'stopGuidance');
                    if (routeSession) routeSession.started = false;
                    await clearPlan(); update({ status: 'idle', plan: null, stops: [] }); stops = [];
                } else { await clearSearch(); await clearPlan(); update({ status: 'idle', results: [], plan: null }); }
            } catch (error) {
                update({ status: 'error', error: clean(error.message) });
                if (action === 'search' || action === 'chargers') await clearSearch();
                if (['route', 'add-stop', 'recalculate'].includes(action)) await clearPlan();
            } finally {
                busy = false;
                if (closed) await finishClose();
                else locateResults(search);
            }
        },
        stop() {
            closed = true; generation++;
            if (!busy) return finishClose();
        }
    };
}
module.exports = { createActions, contracts, routeOptions, tripDefinition, resultLabel, location, tripStops, metres, seconds };
