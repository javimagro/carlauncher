'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRadio } = require('../../apps/javi_carlauncher/radio-bmw');
const { services, station, sources, picture, seconds } = require('../../apps/javi_carlauncher/radio-datos');
const { valid, consume } = require('../../native/javi-carlab/radio-model');
const { createRadioUI } = require('../../native/javi-carlab/radio-ui');
const { createDriveHub, cards, viewport } = require('../../native/javi-carlab/drivehub-state');
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };
const until = async (fn) => { const deadline = Date.now() + 2000; while (!fn() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10)); assert(fn()); };
const raw = (id = 12, overrides) => Object.assign({ dataBaseIdentifier: id, positionNumber: id - 12, waveBand: 1, stationLongName: 'Radio ' + id,
    frequencyKhz: 98500, id: 4000 + id, titleName: 'Programa', artistName: '', isFavorite: 0, pty: 10, ptyTableType: 0, receptionMode: 0 }, overrides);
const sample = (id = 12, changes) => Object.assign(station(raw(id), 2), changes);
function frame(changes) { return Object.assign({ version: 1, at: Date.now(), available: true, loading: false, busy: false, listError: '',
    stations: [sample()], current: sample(), active: true, sourceKnown: true, result: null, logo: null, artwork: null }, changes); }
function fixture(metadata) {
    let time = 1000;
    const timers = [], calls = [], removed = [], disposed = [], callbacks = {}, attributes = {};
    const values = { currentStationFmDab: { stationListEntry: raw(), radioTextName: 'Actualidad' },
        activeSourceId: 'usb', sources: [{ sourceId: 'native-fm', playerType: 'TUNER_FM', selectable: true }, { sourceId: 'usb', playerType: 8, selectable: true }] };
    function attr(name) {
        return attributes[name] = { getValue: async () => values[name], subscribe: async (cb) => { callbacks[name] = cb; return name; }, unsubscribe: async (id) => removed.push(id) };
    }
    const tuner = { currentStationFmDab: attr('currentStationFmDab'), dataStationList: attr('dataStationList'),
        triggerStationListBroadcast: async (args) => { calls.push(['broadcast', args]); },
        getStationListMetaData: async (args) => { calls.push(['list', args]); return { stationList: args.listType === 2 && !args.startPosition ? [raw()] : [] }; },
        selectStation: async (args) => { calls.push(['tune', args]); return { errorCode: 'EC_NO_ERROR' }; }, dispose: async () => disposed.push('tuner') };
    const media = { sources: attr('sources'), activeSourceId: attr('activeSourceId'),
        selectSource: async (args) => { calls.push(['source', args]); return { result: 0 }; }, dispose: async () => disposed.push('media') };
    const builders = { buildAndInitTypedProxy: async (name, instance) => { assert.equal(instance, '1');
        if (name === services.metadata.name) { if (metadata) return metadata; throw new Error('OPTIONAL_UNAVAILABLE'); }
        return name === services.tuner.name ? tuner : media; } };
    const radio = createRadio(builders, { now: () => time, every: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, cancel: (t) => { t.cancelled = true; } });
    return { radio, tuner, media, timers, calls, callbacks, attributes, values, removed, disposed, advance: (ms) => { time += ms; }, now: () => time };
}
test('radio converts BMW stations, PTY and sources without confusing IP or RF quality with audio', () => {
    assert.equal(sample().category, 'music'); assert.equal(station(raw(12, { pty: 4 }), 2).category, 'sports');
    assert.equal(station(raw(12, { ptyTableType: 1 }), 2).category, '');
    assert.equal(station(raw(12, { waveBand: 8 }), 2), null);
    assert.equal(station(raw(12, { dataBaseIdentifier: -1 }), 2), null);
    assert.equal(sample().frequency, 98.5); assert.equal(sources([{ sourceId: 'app', playerType: 9, selectable: true }]).length, 0);
    assert.equal(picture(Buffer.alloc(102400)), null); assert.equal(picture(Buffer.from('Not a picture')), null);
});
test('BMW ByteBufferData logos decode their data member, without accepting arbitrary bytes', () => {
    const png = Buffer.from([137,80,78,71,13,10,26,10]);
    assert.equal(picture({ format: 1, data: png }), png.toString('base64'));
    assert.equal(picture({ format: 1, data: Buffer.alloc(100) }), null);
});
test('logos use the BMW metadata cache and fall back to the tuner independently of list polling', async () => {
    const jpeg = Buffer.from([255,216,0,0,0,0,0,0]); let metadataRequests = 0;
    const f = fixture({ getStationListMetaData: async () => { metadataRequests++; return { stationList: [raw(12, { stationIconPicture: { format: 2, data: jpeg } })] }; }, dispose: async () => {} });
    await f.radio.ready; await settle();
    await f.radio.command({ id: 'img', op: 'artwork', key: '12', list: 2 });
    assert.equal(f.radio.snapshot().artwork.bytes, jpeg.toString('base64')); assert.equal(metadataRequests, 1);
    f.callbacks.currentStationFmDab({ stationListEntry: raw(12, { stationIconPicture: { format: 2, data: jpeg } }) });
    assert.equal(f.radio.snapshot().logo.bytes, jpeg.toString('base64')); f.radio.stop();
});
test('an unavailable presets list does not prevent top stations or erase receivable stations', async () => {
    const f = fixture(); await f.radio.ready; await settle();
    f.tuner.getStationListMetaData = async (args) => { if (args.listType === 7) throw new Error('NOT_READY'); return { stationList: [raw(args.listType === 2 ? 12 : 13)] }; };
    f.advance(30000); await f.radio.refresh();
    assert.deepEqual(f.radio.snapshot().stations.map((s) => s.list), [2,10]); f.radio.stop();
});
test('incremental lists cannot stand in for an unknown base and unrelated broadcasts cause no refresh storm', async () => {
    const { createLists } = require('../../apps/javi_carlauncher/radio-listas');
    const lists = createLists(() => 1000);
    assert.equal(lists.receive({ listType: 2, isIncrementalUpdate: 1, stationList: [raw()] }), false);
    assert.equal(lists.all().length, 0); assert.equal(lists.receive({ listType: 6 }), true);
    assert.equal(lists.commit(2, [raw()], lists.revision(2)), true);
    assert.equal(lists.find('12', 2).position, 0);
});
test('preset membership follows the station identity even when BMW uses another database id', () => {
    const ui = createRadioUI(); const current = sample();
    ui.receive(frame({ current, stations: [current, sample(99, { list: 7, memoryKey: current.memoryKey })] }), Date.now());
    assert.equal(ui.rows().length, 1); assert.equal(ui.favorite(current), true); ui.filter(0); assert.equal(ui.rows().length, 1); ui.close();
});
test('BMW broadcasts populate the list even when the metadata getter returns no stations', async () => {
    const f = fixture(); await f.radio.ready; await settle();
    f.tuner.getStationListMetaData = async () => ({ stationList: [] });
    f.callbacks.dataStationList({ listType: 'LT_RECEIVABLE_FM_DAB', isIncrementalUpdate: 'OFF', stationList: [raw(14)] });
    assert.deepEqual(f.radio.snapshot().stations.map((s) => s.key), ['14']);
    assert(f.calls.some((c) => c[0] === 'broadcast' && c[1].listType === 2));
    f.radio.stop();
});
test('a broadcast racing a metadata query wins and unrelated presets do not discard FM/DAB', async () => {
    const f = fixture(); await f.radio.ready; await settle(); let resolve;
    f.tuner.getStationListMetaData = async (args) => args.listType === 2 ? new Promise((r) => { resolve = r; }) : { stationList: [] };
    f.advance(30000); const pending = f.radio.refresh(); await settle();
    f.callbacks.dataStationList({ listType: 2, isIncrementalUpdate: 0, stationList: [raw(13)] });
    resolve({ stationList: [raw()] }); await pending;
    assert.equal(f.radio.snapshot().stations[0].key, '13');
    f.advance(30000); const second = f.radio.refresh(); await settle();
    f.callbacks.dataStationList({ listType: 7, isIncrementalUpdate: 0, stationList: [raw(13)] });
    resolve({ stationList: [raw(14)] }); await second;
    assert.equal(f.radio.snapshot().stations.find((s) => s.list === 2).key, '14'); f.radio.stop();
});
test('full and incremental BMW lists preserve other rows and reject tuning until an invalid update recovers', async () => {
    const f = fixture(); await f.radio.ready; await settle();
    f.callbacks.dataStationList({ listType: 2, isIncrementalUpdate: 0, stationList: [raw(), raw(13)] });
    f.callbacks.dataStationList({ listType: 2, isIncrementalUpdate: 1, stationList: [raw(13, { stationLongName: 'Actualizada' })] });
    assert.equal(f.radio.snapshot().stations.length, 2);
    assert.equal(f.radio.snapshot().stations[1].name, 'Actualizada');
    f.callbacks.dataStationList({ listType: 7 });
    assert.equal(await f.radio.command({ id: 'x', op: 'tune', key: '12', list: 2 }), true);
    f.callbacks.dataStationList({ listType: 2, isIncrementalUpdate: 0, stationList: [] });
    assert.equal(f.radio.snapshot().stations.length, 0); f.radio.stop();
});
test('opening reads the tuner without starting audio; selection uses native source then BMW database id and index', async () => {
    const f = fixture(); await f.radio.ready; await settle();
    assert(!f.calls.some((c) => ['source', 'tune'].includes(c[0])));
    assert(valid(f.radio.snapshot())); assert.equal(f.radio.snapshot().current.text, 'Actualidad');
    assert.equal(await f.radio.command({ id: 'a', op: 'tune', key: '12', list: 2 }), true);
    assert.deepEqual(f.calls.slice(-2), [['source', { sourceId: 'native-fm' }], ['tune', { listType: 2, dataBaseIdentifier: 12, positionIndex: 0 }]]);
    f.radio.stop(); await settle(); assert.equal(f.disposed.length, 2); assert.equal(f.removed.length, 4);
    assert(f.timers.every((t) => t.cancelled)); assert(!f.calls.some((c) => c[0] === 'mute'));
});
test('failed native source selection prevents tuning and stale lists cannot select another row', async () => {
    const f = fixture(); await f.radio.ready; await settle(); f.media.selectSource = async () => ({ result: 3 });
    assert.equal(await f.radio.command({ id: 'a', op: 'tune', key: '12', list: 2 }), false);
    assert(!f.calls.some((c) => c[0] === 'tune'));
    f.callbacks.dataStationList({ listType: 2 }); f.media.selectSource = async () => ({ result: 0 });
    assert.equal(await f.radio.command({ id: 'b', op: 'tune', key: '12', list: 2 }), false);
    f.advance(2001); await f.radio.refresh();
    assert.equal(await f.radio.command({ id: 'c', op: 'tune', key: '12', list: 2 }), true); f.radio.stop();
});
test('a pending source change never sends a tune after hiding, and concurrent commands do not overlap', async () => {
    const f = fixture(); await f.radio.ready; await settle(); let resolve;
    f.media.selectSource = () => new Promise((r) => { resolve = r; });
    const first = f.radio.command({ id: 'a', op: 'tune', key: '12', list: 2 });
    assert.equal(await f.radio.command({ id: 'b', op: 'tune', key: '12', list: 2 }), false);
    f.radio.stop(); resolve({ result: 0 }); await first; assert(!f.calls.some((c) => c[0] === 'tune'));
});
test('radio paging preserves BMW indices, discards raced pages and expires stale data independently', async () => {
    const f = fixture(); await f.radio.ready; await settle();
    f.tuner.getStationListMetaData = async (args) => ({ stationList: args.listType !== 2 ? [] :
        Array.from({ length: args.startPosition === 0 ? 32 : 3 }, (_, i) => raw(12 + args.startPosition + i)) });
    f.advance(30000); await f.radio.refresh(); assert.equal(f.radio.snapshot().stations.length, 35);
    assert.equal(f.radio.snapshot().current, null); assert.equal(f.radio.snapshot().active, false);
    f.advance(90001); assert.equal(f.radio.snapshot().stations.length, 0); f.radio.stop();
});
test('old getters cannot overwrite station notifications and late-created proxies are disposed', async () => {
    const f = fixture(); await f.radio.ready; await settle(); let resolve;
    f.attributes.currentStationFmDab.getValue = () => new Promise((r) => { resolve = r; });
    const poll = f.timers.find((t) => t.ms === 5000); poll.fn(); await settle();
    f.callbacks.currentStationFmDab({ stationListEntry: raw(13), radioTextName: 'Nueva' });
    resolve({ stationListEntry: raw(12) }); await settle(); assert.equal(f.radio.snapshot().current.key, '13'); f.radio.stop();
    let dispose = 0; const waiting = [];
    const late = createRadio({ buildAndInitTypedProxy: () => new Promise((r) => waiting.push(r)) }, { every: () => 1, cancel: () => {} });
    late.stop(); waiting.forEach((r) => r({ dispose: async () => { dispose++; } })); await late.ready; await settle(); assert.equal(dispose, Object.keys(services).length);
});
test('radio image retrieval asks only for the selected BMW row and refuses a mismatched response', async () => {
    const f = fixture(); await f.radio.ready; await settle();
    f.tuner.getStationListMetaData = async (args) => { assert.equal(args.pictures, 1); assert.equal(args.length, 1); return { stationList: [raw(999, { stationIconPicture: Buffer.from([255,216,0,0,0,0,0,0]) })] }; };
    await f.radio.command({ id: 'logo', op: 'artwork', key: '12', list: 2 }); assert.equal(f.radio.snapshot().artwork.bytes, null); f.radio.stop();
});
test('radio UTF-8 frames survive packet splitting and reject malformed stations and oversized messages', () => {
    const f = frame({ current: sample(12, { name: 'Música' }) }); const data = Buffer.from(JSON.stringify(f) + '\n'), received = [];
    const read = consume((v) => received.push(v)); const cut = data.indexOf(Buffer.from('ú')) + 1;
    assert(read(data.slice(0, cut))); assert(read(data.slice(cut))); assert.equal(received[0].current.name, 'Música');
    assert(!consume(() => {})(Buffer.alloc(1024 * 1024 + 1)));
    assert(!valid(frame({ stations: [sample(12, { position: -1 })] })));
});
test('native favorites, popular and PTY filters use BMW metadata and local overrides persist', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bmw-radio-')); const file = path.join(dir, 'radio.json');
    try {
        const ui = createRadioUI({ radioFile: file });
        const f = frame({ stations: [sample(), sample(13, { category: 'sports' }), sample(12, { list: 7 }), sample(13, { list: 10 })] });
        ui.receive(f, Date.now()); ui.filter(0); assert.deepEqual(ui.rows().map((s) => s.key), ['12']);
        ui.toggleFavorite(ui.rows()[0]); assert.equal(ui.rows().length, 0); await until(() => fs.existsSync(file));
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')); assert.equal(saved.favorites[0][1], false); ui.close();
        const restored = createRadioUI({ radioFile: file }); restored.receive(f, Date.now()); restored.filter(0); await until(() => restored.rows().length === 0);
        restored.filter(0); restored.filter(1); assert.deepEqual(restored.rows().map((s) => s.key), ['13']); restored.close();
    } finally { fs.rmSync(dir, { recursive: true }); }
});
test('rotary and touch select radio rows, long press toggles favorite and lateral tilt returns to the cards', () => {
    const commands = [], ui = createRadioUI({ radioCommand: (c) => { commands.push(c); return true; } });
    ui.receive(frame({ stations: [sample(), sample(13)] }), Date.now()); ui.update(Date.now(), true);
    let clock = 0; const panel = createDriveHub(() => {}, () => clock, null, ui);
    panel.controller({ knob: 10, press: 0, tilt: 0 }); panel.controller({ knob: 11, press: 0, tilt: 0 });
    assert.equal(panel.state.selected, 1); panel.controller({ knob: 12, press: 0, tilt: 0 }); assert.equal(ui.state.mode, 'list');
    panel.controller({ knob: 13, press: 0, tilt: 0 }); assert.equal(ui.state.index, 1);
    panel.controller({ knob: 13, press: 1, tilt: 0 }); panel.controller({ knob: 13, press: 2, tilt: 0 }); panel.controller({ knob: 13, press: 0, tilt: 0 });
    assert(ui.favorite(ui.rows()[1])); assert(!commands.some((c) => c.op === 'tune'));
    panel.controller({ knob: 13, press: 1, tilt: 0 }); panel.controller({ knob: 13, press: 0, tilt: 0 });
    assert.equal(commands[commands.length - 1].key, '13');
    panel.controller({ knob: 13, press: 0, tilt: 10 }); assert.equal(ui.state.mode, 'playing'); assert.equal(panel.state.selected, 1);
    panel.controller({ knob: 13, press: 0, tilt: 0 }); panel.controller({ knob: 13, press: 0, tilt: 10 }); assert.equal(panel.state.selected, 0);
    clock = 300; const x = viewport.x + cards[1].x + 80;
    panel.touch('down', x, 90); panel.touch('up', x, 90); assert.equal(ui.state.mode, 'list'); ui.close();
});
test('decorative spectrum only animates when the visible card has the original radio source active', () => {
    const ui = createRadioUI(); ui.receive(frame(), 1000); ui.update(1100, true); ui.update(1200, true); assert(ui.levels.some((n) => n > .025));
    ui.receive(frame({ active: false }), 1200); ui.update(1300, true); assert(ui.levels.every((n) => n === .025));
    ui.receive(frame(), 1400); ui.update(1500, false); assert(ui.levels.every((n) => n === .025));
    ui.update(7000, true); assert.equal(ui.state.frame.current, null); ui.close();
});
test('radio modules are shipped with explicit OAP extensions and narrow permissions', () => {
    const base = path.join(__dirname, '../..'); const manifest = require('../../apps/javi_carlauncher/package/manifest.json');
    const app = require('../../apps/javi_carlauncher/mgu-app.json'); const native = require('../../native/javi-carlab/component.json');
    ['radio-bmw.js', 'radio-datos.js', 'radio-listas.js'].forEach((n) => assert(app.modules.includes(n)));
    ['radio-model.js', 'radio-ui.js', 'radio-view.js'].forEach((n) => assert(native.files.some((f) => f.from === n)));
    for (const d of Object.values(services)) assert.deepEqual(manifest.proxies[d.name], { instances: ['1'], attributes: Object.fromEntries(d.attributes.map((n) => [n, 'rs'])), methods: d.methods, ...(d.broadcasts ? { broadcasts: d.broadcasts } : {}) });
    assert(fs.readFileSync(path.join(base, 'apps/javi_carlauncher/radio-bmw.js'), 'utf8').includes("require('./radio-datos.js')"));
});
test('programme times come only from the requested now/next scope and the BMW reference clock', () => {
    const row = raw(12, { epgDayViewsList: [{ day: 1, eventsList: [{ eventName: 'Programa',
        eventStartTime: { hour: 23, minute: 30, second: 0 }, eventEndTime: { hour: 0, minute: 30, second: 0 } }] }] });
    assert.equal(station(row, 2).programme, null);
    assert.deepEqual(station(row, 2, true).programme, { name: 'Programa', start: 84600, end: 1800 });
    assert.equal(seconds({ hour: 24, minute: 0, second: 0 }), null); assert.equal(seconds(undefined), null);
});
test('images completing after hiding cannot change the radio card', async () => {
    let resolve;
    const ui = createRadioUI({ photo: () => new Promise((r) => { resolve = r; }) });
    ui.update(Date.now(), true);
    ui.receive(frame({ logo: { key: '12', serial: 1, bytes: Buffer.from([255,216,0,0,0,0,0,0]).toString('base64') } }), Date.now());
    ui.update(Date.now(), false); resolve({ fakeImage: true }); await settle(); assert.equal(ui.images.size, 0); ui.close();
});
test('unavailable BMW services retry while visible and stop retrying on close', async () => {
    const callbacks = [], disposed = [];
    let attempts = 0;
    const r = createRadio({ buildAndInitTypedProxy: async () => { attempts++; throw new Error('NOT_AVAILABLE'); } },
        { every: (fn, ms) => { const t = { fn, ms }; callbacks.push(t); return t; }, cancel: (t) => disposed.push(t) });
    await r.ready; assert.equal(attempts, 3); callbacks[0].fn(); await settle(); assert.equal(attempts, 6);
    r.stop(); callbacks[0].fn(); await settle(); assert.equal(attempts, 6); assert.equal(disposed.length, 1);
});
