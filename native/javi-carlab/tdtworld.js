'use strict';

const fs = require('fs');
const path = require('path');
const download = require('./drivehub-network.js');
const { loadPhoto } = require('./drivehub-data.js');
const { dropImage } = require('./vendor/kit_record.js');
const catalog = require('./tdt-catalog.js');
const { channels, visibleChannels } = require('./tdtworld-data.js');

const menu = ['Guía de programación', 'Mis favoritos', 'Añadir a favoritos', 'Configuración', 'Actualizar canales', 'Volver'];
const settings = ['País', 'Categoría', 'Orden de canales', 'Iniciar en el último canal', 'Duración de la información', 'Volver'];
const filters = catalog.categories;
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
        actionX: w - 103, menuX: 24, menuTop: 55, menuRow: 52 };
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

function createTdt({ fixture, tdtDirectory, get = download, tdtPlayer, now = Date.now, photo = loadPhoto }, change) {
    const file = (name) => tdtDirectory && path.join(tdtDirectory, 'tdt-' + name);
    const store = loadJson(file('settings.json'), {});
    const prefs = {
        country: catalog.countries[store.country] ? store.country : 'es',
        filters: Array.isArray(store.filters) ? store.filters.filter((value) => filters.includes(value)) : filters.slice(),
        alphabetical: store.alphabetical === true,
        order: store.order && typeof store.order === 'object' ? store.order : {},
        resume: store.resume === true,
        seconds: seconds.includes(store.seconds) ? store.seconds : 5,
        favorites: Array.isArray(store.favorites) ? store.favorites : [],
        last: store.last && typeof store.last === 'object' ? store.last : {}
    };
    const state = {
        prefs, channels: [], channel: 0, firstChannel: 0, mode: 'browse', option: 0,
        programOffset: null, status: 'loading', guideStatus: 'loading', playback: 'idle', favoritesOnly: false
    };
    const fixtureChannels = fixture && (fixture.tdtChannels || channels.map((item, index) => Object.assign({
        id: 'preview-' + index, sources: [], group: catalog.categories[0]
    }, item)));
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
    let startup = true;
    let pendingLogo = false;
    const logos = new Map();
    const catalogWaiters = new Set();

    function savePrefs() { save(file('settings.json'), prefs); }
    function selected() { return state.channels[state.channel]; }
    function favoriteId(item) { return prefs.country + '/' + item.id; }
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

    function orderedChannels() {
        const order = prefs.order[prefs.country] || [];
        const ranks = new Map(order.map((id, i) => [id, i]));
        if (!prefs.alphabetical && !ranks.size) return entries;
        return entries.map((item, index) => ({ item, index, rank: ranks.has(item.id) ? ranks.get(item.id) : order.length + index }))
            .sort((a, b) => (prefs.alphabetical ? a.item.name.localeCompare(b.item.name, 'es') : a.rank - b.rank) || a.index - b.index)
            .map((entry) => entry.item);
    }

    function filterChannels(id) {
        state.channels = orderedChannels().filter((item) => prefs.filters.includes(item.group)
            && (!state.favoritesOnly || prefs.favorites.includes(favoriteId(item))));
        setChannel(Math.max(0, state.channels.findIndex((item) => item.id === id)));
    }

    function readCountry() {
        const country = prefs.country;
        guide = undefined;
        fanart = undefined;
        if (fixtureChannels) {
            entries = fixtureChannels;
            guide = fixture.tdtGuide;
            fanart = fixture.tdtFanart;
        } else {
            const cached = loadJson(file(country + '-channels.json'), []);
            entries = Array.isArray(cached) ? cached : [];
        }
        state.guideStatus = guide ? 'ready' : 'loading';
        state.status = entries.length ? 'ready' : 'loading';
        catalogDue = guideDue = 0;
        state.firstChannel = 0;
        filterChannels(prefs.resume ? prefs.last[country] : undefined);
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
                save(file(country + '-channels.json'), value);
                filterChannels(item ? item.id : prefs.resume ? prefs.last[country] : undefined);
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

    function loadLogo() {
        if (pendingLogo || state.mode !== 'browse') return;
        const channel = state.channels.slice(state.firstChannel, state.firstChannel + visibleChannels)
            .find((item) => item.logo && item.logo.startsWith('https://') && !logos.has(item.logo));
        if (!channel) return;
        pendingLogo = true;
        photo(channel.logo, get, 31, 31, true, () => !closed && active && state.mode === 'browse').then((image) => {
            if (closed) { dropImage(image); return; }
            logos.set(channel.logo, image);
            change();
        }, (error) => { if (!closed && error.code !== 'IMAGE_CANCELLED') logos.set(channel.logo, null); }).then(() => {
            pendingLogo = false;
            if (logos.size > 40) {
                const first = logos.keys().next().value;
                const image = logos.get(first);
                if (image) dropImage(image);
                logos.delete(first);
            }
        });
    }

    function showArt(time) {
        const item = selected();
        const current = program(item, time, true);
        const images = current && [fanart && item && (fanart.get(item.id + ':' + current.start)
            || fanart.get(catalog.key(item.name) + ':' + current.start)), current.icon];
        const urls = (images || []).filter((value) => typeof value === 'string' && value.startsWith('https://'));
        const next = urls.join('\n');
        if (artUrl === next) return;
        artUrl = next;
        releaseArt();
        const job = {};
        pendingArt = job;
        if (!urls.length) return;
        async function fetchArt() {
            for (const url of urls) {
                if (job !== pendingArt) return;
                try {
                    const image = await photo(url, get, 528, 297, false, () => !closed && job === pendingArt && state.mode !== 'player');
                    if (job !== pendingArt) { dropImage(image); return; }
                    state.art = image;
                    change();
                    return;
                } catch (_) { /* The programme's EPG icon is the second source. */ }
            }
        }
        clearTimeout(artTimer);
        artTimer = setTimeout(fetchArt, 130);
    }

    function stop() {
        tuning++;
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
        clearTimeout(artTimer);
        pendingArt = undefined;
        artUrl = undefined;
        state.playback = 'loading';
        state.overlayUntil = Infinity;
        change();
        if (!tdtPlayer) { state.playback = 'unavailable'; change(); return; }
        try {
            const sources = await catalog.resolveSources(item, get);
            if (request !== tuning) return;
            if (!sources.length) state.playback = 'no-source';
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
                    state.overlayUntil = now() + prefs.seconds * 1000;
                    if (prefs.last[prefs.country] !== item.id) {
                        prefs.last[prefs.country] = item.id;
                        savePrefs();
                    }
                }
                change();
            });
        } catch (_) {
            if (request !== tuning) return;
            state.playback = 'error';
        }
        change();
    }

    function setMode(mode) {
        if (state.mode === 'player') stop();
        state.mode = mode;
        state.option = 0;
        if (mode !== 'guide') state.programOffset = null;
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

    function showOverlay() {
        state.overlayUntil = now() + Math.max(prefs.seconds, 3) * 1000;
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
        if (index === 1) { setMode('filters'); return; }
        if (index === 2) { setMode('order'); return; }
        if (index === 3) prefs.resume = !prefs.resume;
        if (index === 4) prefs.seconds = cycle(seconds, prefs.seconds);
        if (index === 5) { setMode('menu'); return; }
        const item = selected();
        filterChannels(item && item.id);
        savePrefs();
    }

    function toggleFilter(index) {
        const name = filters[index];
        if (!name) { setMode('settings'); return; }
        const item = selected();
        prefs.filters = prefs.filters.includes(name) ? prefs.filters.filter((value) => value !== name) : prefs.filters.concat(name);
        filterChannels(item && item.id);
        savePrefs();
    }

    function reorder(delta) {
        const item = selected();
        const other = state.channels[state.channel + delta];
        if (!item || !other) return;
        const order = orderedChannels().map((channel) => channel.id);
        const from = order.indexOf(item.id);
        const to = order.indexOf(other.id);
        order.splice(from, 1);
        order.splice(to, 0, item.id);
        prefs.alphabetical = false;
        prefs.order[prefs.country] = order;
        filterChannels(item.id);
        savePrefs();
    }

    function chooseOrder(index) {
        if (index === 0) { setMode('settings'); return; }
        const item = selected();
        prefs.alphabetical = index === 2;
        if (index === 1) delete prefs.order[prefs.country];
        filterChannels(item && item.id);
        savePrefs();
    }

    function applyMenu(index) {
        const item = selected();
        if (index === 0) setMode('guide');
        if (index === 1) {
            state.favoritesOnly = !state.favoritesOnly;
            filterChannels(item && item.id);
            setMode('browse');
        }
        if (index === 2 && item) {
            const id = favoriteId(item);
            if (prefs.favorites.includes(id)) prefs.favorites = prefs.favorites.filter((value) => value !== id);
            else prefs.favorites.push(id);
            savePrefs();
            filterChannels(item.id);
            setMode('browse');
        }
        if (index === 3) setMode('settings');
        if (index === 4) { generation++; update = null; catalogDue = guideDue = 0; setMode('browse'); }
        if (index === 5) setMode('browse');
    }

    let countryLoaded = false;
    if (fixture) { readCountry(); countryLoaded = true; }
    return {
        state, selected, programs, program,
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
        playNamed(id) { const index = state.channels.findIndex((c) => c.id === id); if (index >= 0 && !closed) { setChannel(index); play(); } },
        logo: (item) => logos.get(item.logo),
        time(value) {
            const country = prefs.country;
            if (!clocks.has(country)) clocks.set(country, new Intl.DateTimeFormat('en-GB', {
                hour: '2-digit', minute: '2-digit', hour12: false, timeZone: catalog.zones[country]
            }));
            return clocks.get(country).format(value);
        },
        guideStart(time) {
            const rows = programs();
            const selectedIndex = state.programOffset === null ? catalog.currentIndex(rows, time) : state.programOffset;
            return Math.max(0, Math.min(rows.length - visibleChannels, selectedIndex - Math.floor(visibleChannels / 2)));
        },
        playerStart() {
            return Math.max(0, Math.min(state.channels.length - visibleChannels,
                state.playerChoice - Math.floor(visibleChannels / 2)));
        },
        menu: () => menu.map((label, i) => {
            if (i === 1 && state.favoritesOnly) return 'Todos los canales';
            if (i === 2 && selected() && prefs.favorites.includes(favoriteId(selected()))) return 'Quitar de favoritos';
            return label;
        }),
        settings: () => settings.map((label, i) => ({
            label, value: [catalog.countries[prefs.country], prefs.filters.length === filters.length ? 'Todas' : prefs.filters.length + ' activas',
                prefs.alphabetical ? 'Alfabético' : prefs.order[prefs.country] ? 'Personalizado' : 'Del catálogo',
                prefs.resume ? 'Sí' : 'No', prefs.seconds ? prefs.seconds + ' s' : 'Oculta'][i]
        })),
        filters: () => filters.map((name) => ({ label: name, value: prefs.filters.includes(name) ? 'Sí' : 'No' }))
            .concat({ label: 'Volver' }),
        update(time, focused) {
            if (!focused && (active || state.mode !== 'browse')) {
                clearTimeout(artTimer);
                pendingArt = undefined;
                artUrl = undefined;
                releaseArt();
                setMode('browse');
            }
            active = focused;
            if (!active) return;
            if (!countryLoaded) { readCountry(); countryLoaded = true; }
            refresh(time);
            if (startup && (state.channels.length || state.status === 'offline')) {
                startup = false;
                const last = prefs.last[prefs.country];
                if (prefs.resume && last && selected() && last === selected().id && state.mode === 'browse') play();
            }
            if (state.mode !== 'player') showArt(time);
            loadLogo();
        },
        rotate(delta) {
            if (['menu', 'settings', 'filters'].includes(state.mode)) {
                state.option = clamp(state.option + delta, 0, state.mode === 'filters' ? filters.length : menu.length - 1);
                change();
                return;
            }
            if (state.playerChoice !== undefined) { movePlayerChoice(delta); return; }
            const before = state.channel;
            setChannel(before + delta);
            if (state.mode === 'player' && before !== state.channel) play();
        },
        tilt(delta) {
            if (state.mode === 'browse' || state.mode === 'guide') moveProgram(delta, now());
            if (state.mode === 'order') reorder(delta);
            if (state.mode === 'player') {
                if (state.playerChoice !== undefined) movePlayerChoice(delta);
                else this.rotate(-delta);
            }
            if (state.mode === 'settings') applySetting(state.option, delta);
        },
        press(long) {
            if (state.mode === 'player') {
                if (long) togglePlayerChannels();
                else if (state.playerChoice !== undefined) { setChannel(state.playerChoice); play(); }
                else showOverlay();
                return;
            }
            if (long) { setMode(state.mode === 'menu' ? 'browse' : 'menu'); return; }
            if (state.mode === 'menu') { applyMenu(state.option); return; }
            if (state.mode === 'settings') { applySetting(state.option, 1); return; }
            if (state.mode === 'filters') { toggleFilter(state.option); return; }
            if (state.mode === 'order') { setMode('settings'); return; }
            if (state.mode === 'guide') { setMode('browse'); return; }
            play();
        },
        touch(x, y, w, h, scroll) {
            const l = layout(w, h);
            if (scroll) {
                if (state.mode === 'guide' || x >= l.detailX) this.tilt(scroll);
                else this.rotate(scroll);
                return;
            }
            if (y < 38 && x >= l.actionX) {
                setMode(state.mode === 'browse' ? 'menu' : ['filters', 'order'].includes(state.mode) ? 'settings' : 'browse');
                return;
            }
            if (['menu', 'settings', 'filters'].includes(state.mode)) {
                const row = Math.floor((y - l.menuTop) / l.menuRow);
                if (row < 0 || row >= (state.mode === 'filters' ? filters.length + 1 : menu.length)) return;
                if (state.mode === 'menu') applyMenu(row);
                else if (state.mode === 'filters') toggleFilter(row);
                else applySetting(row, x < w / 2 ? -1 : 1);
                return;
            }
            if (state.mode === 'player') {
                if (y < 38 && x <= 111) { togglePlayerChannels(); return; }
                if (state.playerChoice !== undefined && x < l.detailX && y >= l.top && y < l.top + l.rowHeight * visibleChannels) {
                    const index = this.playerStart() + Math.floor((y - l.top) / l.rowHeight);
                    if (index < state.channels.length) { setChannel(index); play(); }
                } else showOverlay();
                return;
            }
            if (state.mode === 'guide') {
                if (x < l.detailX && y >= l.top && y < l.top + l.rowHeight * visibleChannels) {
                    const index = this.guideStart(now()) + Math.floor((y - l.top) / l.rowHeight);
                    if (index < programs().length) { state.programOffset = index; change(); }
                }
                return;
            }
            if (y < l.top || y >= l.top + l.body) return;
            if (x < l.detailX) {
                const row = Math.floor((y - l.top) / l.rowHeight);
                const index = state.firstChannel + row;
                if (row >= visibleChannels || index >= state.channels.length) return;
                if (index === state.channel && state.mode === 'browse') play();
                else setChannel(index);
            } else if (state.mode === 'order') {
                if (y < l.top + 2 * l.menuRow) reorder(y < l.top + l.menuRow ? -1 : 1);
                else if (y < l.top + 4 * l.menuRow) chooseOrder(y < l.top + 3 * l.menuRow ? 1 : 2);
            } else if (x >= w - 146 && y >= h - 49 && y < h - 19) play();
        },
        video: () => tdtPlayer && tdtPlayer.frame(),
        close() {
            closed = true;
            catalogWaiters.forEach((finish) => finish('cancelled'));
            generation++;
            clearTimeout(artTimer);
            pendingArt = undefined;
            releaseArt();
            logos.forEach((image) => { if (image) dropImage(image); });
            logos.clear();
            stop();
        }
    };
}

module.exports = { createTdt, layout, visibleChannels };
