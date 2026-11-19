'use strict';

const fs = require('fs');
const path = require('path');
const download = require('./drivehub-network.js');
const { loadPhoto } = require('./drivehub-data.js');
const { dropImage } = require('./vendor/kit_record.js');
const catalog = require('./tdt-catalog.js');
const { createLogos } = require('./tdt-logos.js');
const { previewChannels, visibleChannels } = require('./tdtworld-data.js');

const playerOverlay = { height: 128, logoSize: 90, posterWidth: 96 };
const settings = ['País', 'Duración de la información', 'Iniciar en el último canal', 'Audio'];
const clocks = new Map();
const seconds = [0, 3, 5, 8, 12];
const interval = 30 * 60000;
const retry = 60000;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function layout(w, h) {
    const top = 45;
    const listWidth = Math.round(w * 0.375) - 18;
    const body = h - 54;
    return { top, body, listWidth, rowHeight: Math.floor(body / visibleChannels),
        detailX: listWidth + 17, detailWidth: w - listWidth - 26,
        actionX: w - 137, actionWidth: 126, settingsX: 24, settingsTop: 55, settingsRow: 52 };
}

function load(file, fallback) {
    if (!file) return fallback;
    try { return fs.readFileSync(file); }
    catch (_) { return fallback; }
}

function loadJson(file, fallback) {
    try { return JSON.parse(load(file, '')); }
    catch (_) { return fallback; }
}

function save(file, value) {
    if (!file) return;
    const temp = file + '.tmp';
    try {
        fs.writeFileSync(temp, Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode: 0o600 });
        fs.renameSync(temp, file);
    } catch (err) {
        try { fs.unlinkSync(temp); } catch (_) { /* No temporary file. */ }
        console.warn('TDTWorld: no se pudo guardar ' + path.basename(file) + ' (' + err.code + ')');
    }
}

function createTdt({ fixture, tdtDirectory, get = download, tdtPlayer, tdtMediaset, now = Date.now, photo = loadPhoto }, change) {
    const file = (name) => tdtDirectory && path.join(tdtDirectory, 'tdt-' + name);
    const store = loadJson(file('settings.json'), {});
    const prefs = {
        country: catalog.countries[store.country] ? store.country : 'es',
        resume: store.resume === true,
        audioMode: store.audioMode === 'bmw-sample' ? 'bmw-sample' : 'live',
        seconds: seconds.includes(store.seconds) ? store.seconds : 5,
        last: store.last && typeof store.last === 'object' ? store.last : {}
    };
    const state = {
        prefs, channels: [], channel: 0, firstChannel: 0, mode: 'browse', option: 0,
        programOffset: null, status: 'loading', guideStatus: 'loading', playback: 'idle'
    };
    let entries = [];
    let guide;
    let fanart;
    let active = false;
    let closed = false;
    let generation = 0;
    let update;
    let catalogDue = 0;
    let guideDue = 0;
    let artUrl;
    let displayedChannel;
    let pendingArt;
    let artTimer;
    let tuning = 0;
    let sourceLookup;
    let startup = true;
    let overlayWasVisible = false;
    const logos = createLogos(change);
    const catalogWaiters = new Set();

    function savePrefs() { save(file('settings.json'), prefs); }
    function selected() { return state.channels[state.channel]; }
    function programs(item = selected()) { return catalog.schedule(guide, item); }
    function program(item, time, browsing) {
        if (!item) return undefined;
        const rows = programs(item);
        if (rows.length) {
            if (browsing && state.programOffset !== null) return rows[clamp(state.programOffset, 0, rows.length - 1)];
            const match = rows[catalog.currentIndex(rows, time)];
            return match && match.start <= time && time < match.end ? match : undefined;
        }
        if (fixture && item.title) return { title: item.title, description: item.summary,
            startLabel: item.start, endLabel: item.end, progress: item.progress };
        return undefined;
    }

    function setChannel(index) {
        state.channel = clamp(index, 0, Math.max(0, state.channels.length - 1));
        state.firstChannel = clamp(state.firstChannel, Math.max(0, state.channel - visibleChannels + 1),
            Math.min(state.channel, Math.max(0, state.channels.length - visibleChannels)));
        const item = selected();
        if (item !== displayedChannel) {
            displayedChannel = item;
            state.programOffset = null;
        }
        change();
    }

    function setChannels(id) {
        const choice = state.playerChoice === undefined ? undefined : state.channels[state.playerChoice];
        state.channels = entries;
        const playing = entries.findIndex((item) => item.id === id);
        if (playing < 0 && state.mode === 'player') setMode('browse');
        setChannel(Math.max(0, playing));
        if (choice) {
            const index = entries.findIndex((item) => item.id === choice.id);
            state.playerChoice = index < 0 ? undefined : index;
        }
    }

    const channelFile = (country) => file((country === 'es' ? 'es-domestic' : country) + '-channels.json');

    function readCountry() {
        const country = prefs.country;
        guide = undefined;
        fanart = undefined;
        if (fixture) {
            entries = country === 'es' && fixture.tdtChannels || previewChannels(country);
            if (country === 'es') {
                guide = fixture.tdtGuide;
                fanart = fixture.tdtFanart;
            }
        } else {
            const cached = loadJson(channelFile(country), []);
            entries = Array.isArray(cached) ? catalog.orderChannels(country, cached) : [];
        }
        state.guideStatus = guide ? 'ready' : 'loading';
        state.status = entries.length ? 'ready' : 'loading';
        catalogDue = guideDue = 0;
        state.firstChannel = 0;
        setChannels(prefs.resume ? prefs.last[country] : undefined);
    }

    function loadGuide(country, current) {
        const slots = [
            { name: 'epg', parse: catalog.parseGuide, set: (value) => { guide = value; state.guideStatus = 'ready'; } },
            { name: 'fanart', parse: catalog.parseFanart, set: (value) => { fanart = value; } }
        ];
        function install(slot, bytes) {
            return catalog.inflate(bytes).then(slot.parse).then((value) => {
                if (current()) { slot.set(value); change(); }
            });
        }
        const cached = slots.map((slot) => load(file(country + '-' + slot.name + '.gz')));
        const restore = slots.map((slot, i) => cached[i] && install(slot, cached[i]).catch(() => {}));
        return catalog.version(country, get).then((version) => Promise.all(slots.map(async (slot, i) => {
            await restore[i];
            const hash = i === 0 ? version.version : version.fanartVersion;
            if (!hash && i === 1) return true;
            try {
                const bytes = await catalog.dataset(country, slot.name, hash, cached[i], get);
                if (current() && bytes !== cached[i]) {
                    await install(slot, bytes);
                    if (current()) save(file(country + '-' + slot.name + '.gz'), bytes);
                }
                return true;
            } catch (_) { return false; }
        }))).then((results) => results.every(Boolean), () => Promise.all(restore).then(() => false));
    }

    function refresh(time, catalogOnly) {
        if ((!active && !catalogOnly) || fixture || update || (time < catalogDue && (catalogOnly || time < guideDue))) return;
        const country = prefs.country;
        const job = ++generation;
        const current = () => !closed && job === generation;
        const tasks = [];
        if (time >= catalogDue) {
            if (!entries.length) { state.status = 'loading'; change(); }
            tasks.push(catalog.loadCatalog(country, get).then((value) => {
                if (!current()) return;
                const item = selected();
                entries = value;
                state.status = 'ready';
                catalogDue = time + 6 * interval;
                save(channelFile(country), value);
                const id = startup && prefs.resume ? prefs.last[country] : item && item.id;
                setChannels(id);
            }, () => {
                if (!current()) return;
                state.status = entries.length ? 'cached' : 'offline';
                catalogDue = time + retry;
                change();
            }));
        }
        if (!catalogOnly && time >= guideDue) tasks.push(loadGuide(country, current).then((ok) => {
            if (!current()) return;
            if (!ok) state.guideStatus = guide ? 'cached' : 'offline';
            guideDue = time + (ok ? interval : retry);
            change();
        }));
        update = Promise.all(tasks).then(() => { if (current()) update = null; });
    }

    function releaseArt() {
        if (state.art) dropImage(state.art);
        state.art = undefined;
    }

    function clearArt() {
        clearTimeout(artTimer);
        pendingArt = undefined;
        artUrl = undefined;
        releaseArt();
    }

    function overlayVisible(time) {
        return state.mode === 'player' && state.overlayUntil > time;
    }

    function logoRows(time) {
        const first = state.mode === 'browse' ? state.firstChannel : playerStart();
        const rows = first === undefined ? [] : state.channels.slice(first, first + visibleChannels);
        return overlayVisible(time) ? [selected()].concat(rows) : rows;
    }

    function showArt(time) {
        const item = selected();
        const browsing = state.mode === 'browse';
        const current = program(item, time, browsing);
        const images = current && [fanart && item && (fanart.get(item.id + ':' + current.start)
            || fanart.get(catalog.key(item.name) + ':' + current.start)), current.icon];
        const urls = (images || []).filter((value) => typeof value === 'string' && value.startsWith('https://'));
        const next = (browsing ? 'browse:' : 'player:') + urls.join('\n');
        if (artUrl === next) return;
        clearArt();
        artUrl = next;
        if (!urls.length) return;
        const job = {};
        pendingArt = job;
        const valid = () => !closed && active && job === pendingArt && (browsing ? state.mode === 'browse' : overlayVisible(now()));
        const width = browsing ? 528 : playerOverlay.posterWidth, height = browsing ? 297 : playerOverlay.height;
        async function fetchArt() {
            for (const url of urls) {
                if (!valid()) return;
                try {
                    const image = await photo(url, get, width, height, false, valid);
                    if (!valid()) { dropImage(image); return; }
                    state.art = image;
                    change();
                    return;
                } catch (_) { /* The programme's EPG icon is the second source. */ }
            }
        }
        artTimer = setTimeout(fetchArt, 130);
    }

    function stop() {
        tuning++;
        if (sourceLookup) { sourceLookup.cancel(); sourceLookup = undefined; }
        if (tdtPlayer) tdtPlayer.stop();
        state.playback = 'idle';
        state.audioStatus = '';
        state.audioDiagnostic = '';
        state.playbackDiagnostic = '';
        state.overlayUntil = 0;
        state.playerChoice = undefined;
    }

    async function play() {
        const item = selected();
        if (!item) return;
        stop();
        const request = tuning;
        state.mode = 'player';
        state.programOffset = null;
        clearArt();
        state.playback = 'loading';
        state.overlayUntil = Infinity;
        function finishOverlay() {
            if (state.overlayUntil === Infinity) state.overlayUntil = now() + prefs.seconds * 1000;
        }
        change();
        if (!tdtPlayer) { state.playback = 'unavailable'; finishOverlay(); change(); return; }
        let lookup;
        try {
            const mediaset = tdtMediaset && (code => {
                lookup = sourceLookup = tdtMediaset(code);
                return lookup.result;
            });
            const sources = await (fixture ? item.sources : catalog.resolveSources(item, get, prefs.country, mediaset));
            if (request !== tuning) return;
            if (!sources.length) { state.playback = 'no-source'; finishOverlay(); }
            else tdtPlayer.start(sources, (status, diagnostic) => {
                if (request !== tuning) return;
                if (status.startsWith('audio-')) {
                    state.audioStatus = status;
                    state.audioDiagnostic = diagnostic || '';
                    change();
                    return;
                }
                if (status !== 'frame') {
                    state.playback = status;
                    state.playbackDiagnostic = diagnostic || '';
                }
                if (status === 'playing') {
                    finishOverlay();
                    if (prefs.last[prefs.country] !== item.id) {
                        prefs.last[prefs.country] = item.id;
                        savePrefs();
                    }
                } else if (['error', 'unavailable', 'native-ended'].includes(status)) finishOverlay();
                change();
            }, prefs.audioMode);
        } catch (_) {
            if (request !== tuning) return;
            state.playback = 'error';
            if (lookup) state.playbackDiagnostic = 'Mediaset no devolvió una emisión';
            finishOverlay();
        } finally {
            if (sourceLookup === lookup) sourceLookup = undefined;
        }
        change();
    }

    function setMode(mode) {
        if (state.mode === 'player') stop();
        state.mode = mode;
        state.option = 0;
        state.programOffset = null;
        clearArt();
        change();
    }

    function togglePlayerChannels() {
        state.playerChoice = state.playerChoice === undefined ? state.channel : undefined;
        change();
    }

    function movePlayerChoice(delta) {
        state.playerChoice = clamp(state.playerChoice + delta, 0, state.channels.length - 1);
        change();
    }

    function playerStart() {
        if (state.playerChoice === undefined) return undefined;
        return clamp(state.playerChoice - Math.floor(visibleChannels / 2), 0, Math.max(0, state.channels.length - visibleChannels));
    }

    function playChannel(index) {
        if (index < 0 || index >= state.channels.length) return;
        if (state.mode === 'player' && state.channel === index && state.playback === 'playing') {
            state.playerChoice = undefined;
            showOverlay();
            return;
        }
        setChannel(index);
        play();
    }

    function showOverlay() {
        if (state.overlayUntil !== Infinity) state.overlayUntil = now() + Math.max(prefs.seconds, 3) * 1000;
        change();
    }

    function moveProgram(delta, time) {
        const rows = programs();
        if (!rows.length) return;
        const from = state.programOffset === null ? catalog.currentIndex(rows, time) : state.programOffset;
        state.programOffset = clamp(from + delta, 0, rows.length - 1);
        change();
    }

    function applySetting(index, direction) {
        const cycle = (values, current) => values[(values.indexOf(current) + direction + values.length) % values.length];
        if (index === 0) {
            prefs.country = cycle(Object.keys(catalog.countries), prefs.country);
            generation++;
            update = null;
            readCountry();
        }
        if (index === 1) prefs.seconds = cycle(seconds, prefs.seconds);
        if (index === 2) prefs.resume = !prefs.resume;
        if (index === 3) prefs.audioMode = prefs.audioMode === 'live' ? 'bmw-sample' : 'live';
        savePrefs();
        change();
    }

    let countryLoaded = false;
    if (fixture) { readCountry(); countryLoaded = true; }
    return {
        state, selected, program, playerStart, overlayVisible,
        prepareChannels(alive) {
            if (closed || !alive()) return Promise.resolve('cancelled');
            if (!countryLoaded) { readCountry(); countryLoaded = true; }
            const country = prefs.country, deadline = Date.now() + 12000;
            refresh(now(), true);
            return new Promise((resolve) => {
                let timer;
                function finish(status) { clearTimeout(timer); catalogWaiters.delete(finish); resolve(status); }
                function check() {
                    if (closed || !alive() || prefs.country !== country) { finish('cancelled'); return; }
                    if (state.channels.length || state.status === 'ready' || state.status === 'cached') { finish('ready'); return; }
                    if (state.status === 'offline') { finish('unavailable'); return; }
                    if (Date.now() >= deadline) { finish('loading'); return; }
                    timer = setTimeout(check, 100);
                }
                catalogWaiters.add(finish); check();
            });
        },
        playNamed(id) { if (!closed) playChannel(state.channels.findIndex((c) => c.id === id)); },
        logo: (item) => logos.image(prefs.country, item),
        time(value) {
            const country = prefs.country;
            if (!clocks.has(country)) clocks.set(country, new Intl.DateTimeFormat('en-GB', {
                hour: '2-digit', minute: '2-digit', hour12: false, timeZone: catalog.zones[country]
            }));
            return clocks.get(country).format(value);
        },
        settings: () => settings.map((label, i) => ({
            label, value: [catalog.countries[prefs.country], prefs.seconds ? prefs.seconds + ' s' : 'Oculta', prefs.resume ? 'Sí' : 'No',
                prefs.audioMode === 'bmw-sample' ? 'Prueba BMW · 30 s' : 'Directo (actual)'][i]
        })),
        update(time, focused) {
            if (!focused && (active || state.mode !== 'browse')) {
                setMode('browse');
            }
            active = focused;
            if (!active) { logos.load(prefs.country, []); return; }
            if (!countryLoaded) { readCountry(); countryLoaded = true; }
            refresh(time);
            if (startup && (state.channels.length || state.status === 'offline')) {
                startup = false;
                const last = prefs.last[prefs.country];
                if (prefs.resume && prefs.audioMode !== 'bmw-sample' && last && selected() && last === selected().id && state.mode === 'browse') play();
            }
            const visible = overlayVisible(time);
            if (visible !== overlayWasVisible) { overlayWasVisible = visible; change(); }
            if (state.mode === 'browse' || visible) showArt(time);
            else if (artUrl !== undefined) clearArt();
            logos.load(prefs.country, logoRows(time));
        },
        rotate(delta) {
            if (state.mode === 'settings') {
                state.option = clamp(state.option + delta, 0, settings.length - 1);
                change();
                return;
            }
            if (state.playerChoice !== undefined) { movePlayerChoice(delta); return; }
            const before = state.channel;
            setChannel(before + delta);
            if (state.mode === 'player' && before !== state.channel) play();
        },
        skip(delta) {
            if (state.mode === 'settings') return;
            const before = state.channel;
            if (state.mode === 'player') playChannel(clamp(before + delta, 0, state.channels.length - 1));
            else setChannel(before + delta);
        },
        tilt(delta) {
            if (state.mode === 'browse') setChannel(state.channel + delta);
            else if (state.playerChoice !== undefined) movePlayerChoice(delta);
            else if (state.mode === 'settings') this.rotate(delta);
        },
        press(long) {
            if (state.mode === 'player') {
                if (long) togglePlayerChannels();
                else if (state.playerChoice !== undefined) playChannel(state.playerChoice);
                else showOverlay();
                return;
            }
            if (long) { setMode(state.mode === 'settings' ? 'browse' : 'settings'); return; }
            if (state.mode === 'settings') { applySetting(state.option, 1); return; }
            play();
        },
        touch(x, y, w, h, scroll) {
            const l = layout(w, h);
            if (scroll) {
                if (state.mode === 'browse' && x >= l.detailX) moveProgram(scroll, now());
                else this.rotate(scroll);
                return;
            }
            if (y >= 3 && y < 38 && x >= l.actionX && x < l.actionX + l.actionWidth) {
                setMode(state.mode === 'browse' ? 'settings' : 'browse');
                return;
            }
            if (state.mode === 'settings') {
                const row = Math.floor((y - l.settingsTop) / l.settingsRow);
                if (x >= l.settingsX && x < w - l.settingsX && row >= 0 && row < settings.length) {
                    state.option = row;
                    applySetting(row, x < w / 2 ? -1 : 1);
                }
                return;
            }
            if (state.mode === 'player' && y >= 3 && y < 38 && x >= 9 && x <= 111) {
                togglePlayerChannels();
                return;
            }
            const first = state.mode === 'browse' ? state.firstChannel : playerStart();
            const row = Math.floor((y - l.top) / l.rowHeight);
            if (first !== undefined && x >= 9 && x < 9 + l.listWidth && row >= 0 && row < visibleChannels) {
                playChannel(first + row);
            } else if (state.mode === 'player') showOverlay();
        },
        video: () => tdtPlayer && tdtPlayer.frame(),
        close() {
            closed = true;
            catalogWaiters.forEach((finish) => finish('cancelled'));
            generation++;
            clearArt();
            logos.close();
            stop();
        }
    };
}

module.exports = { createTdt, layout, playerOverlay, visibleChannels };
