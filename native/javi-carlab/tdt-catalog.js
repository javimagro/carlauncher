'use strict';

const crypto = require('crypto');
const zlib = require('zlib');
const { URL } = require('url');

const guideRoot = 'https://raw.githubusercontent.com/javimagro/TdTTv-EPG/epg-data/epg/';
const catalogUrl = 'https://www.tdtchannels.com/lists/tv.json';
const catalogFallback = 'https://raw.githubusercontent.com/LaQuay/TDTChannels/master/TELEVISION.md';
const countries = { es: 'España', pt: 'Portugal', de: 'Alemania', fr: 'Francia', it: 'Italia', uk: 'Reino Unido' };
const zones = { es: 'Europe/Madrid', pt: 'Europe/Lisbon', de: 'Europe/Berlin',
    fr: 'Europe/Paris', it: 'Europe/Rome', uk: 'Europe/London' };
const categories = ['Generalistas', 'Informativos', 'Deportes', 'Religiosos', 'Autonómicos', 'Otros'];
const atres = {
    antena3: ['Antena 3', '5a6a165a7ed1a834493ebf6a'],
    lasexta: ['laSexta', '5a6a172c7ed1a834493ebf6b'],
    neox: ['Neox', '5a6a17da7ed1a834493ebf6d'],
    nova: ['Nova', '5a6a180b7ed1a834493ebf6e'],
    mega: ['Mega', '5a6a18357ed1a834493ebf6f'],
    atreseries: ['Atreseries', '5a6a189a7ed1a834493ebf70']
};
const mib = 1024 * 1024;

function key(value) {
    return String(value || '').split('@')[0].normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '').replace(/tv$/, '');
}

function mediaUrl(value) {
    try {
        const url = new URL(value);
        if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port
            || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(url.hostname)) return '';
        return url.href;
    } catch (_) { return ''; }
}

function category(value) {
    if (/general|nacional/i.test(value)) return categories[0];
    if (/noticias|news|informati/i.test(value)) return categories[1];
    if (/sport|deporte/i.test(value)) return categories[2];
    if (/religi/i.test(value)) return categories[3];
    if (/auton|local|regio/i.test(value)) return categories[4];
    return categories[5];
}

function channel(name, epg, group, logo, sources) {
    if (!name || !key(epg || name)) return null;
    return { id: key(epg || name), epg, name, group: category(group), logo: mediaUrl(logo),
        sources: Array.from(new Set(sources.map(mediaUrl).filter(Boolean))) };
}

function parseCatalog(text) {
    const entries = [];
    for (const country of JSON.parse(text).countries) {
        for (const ambit of country.ambits) {
            for (const item of ambit.channels) {
                const sources = (item.options || []).filter((option) =>
                    /^(m3u8|mpd)$/i.test(option.format) && !/\[[A-Z_]+\]/.test(option.url));
                entries.push(channel(item.name, item.epg_id, ambit.name, item.logo, sources.map((option) => option.url)));
            }
        }
    }
    return unique(entries);
}

function parseMarkdown(text) {
    const entries = [];
    let group = '';
    for (const line of text.split(/\r?\n/)) {
        if (/^##+ /.test(line)) group = line.replace(/^#+ /, '');
        if (!line.startsWith('| ')) continue;
        const [, name, links, , logo, epg] = line.split('|').map((part) => part.trim());
        if (!epg || name === 'Canal' || name === '-') continue;
        const sources = [];
        const pattern = /\[(?:m3u8|mpd)[^\]]*\]\((https?:\/\/[^)]+)\)/gi;
        let match;
        while ((match = pattern.exec(links))) {
            if (!/\[[A-Z_]+\]/.test(match[1])) sources.push(match[1]);
        }
        entries.push(channel(name, epg === '-' ? '' : epg, group,
            (/(https?:\/\/[^)]+)/.exec(logo) || [])[1], sources));
    }
    return unique(entries);
}

function parseM3u(text) {
    const entries = [];
    let info;
    for (const line of text.split(/\r?\n/)) {
        if (line.startsWith('#EXTINF:')) {
            const comma = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/.exec(line);
            if (!comma) { info = null; continue; }
            const tag = (name) => (new RegExp(name + '="([^"]*)"').exec(line.slice(0, comma.index)) || [])[1] || '';
            info = { name: line.slice(comma.index + 1).trim(), epg: tag('tvg-id'), group: tag('group-title'), logo: tag('tvg-logo') };
        } else if (info && mediaUrl(line.trim())) {
            entries.push(channel(info.name, info.epg, info.group, info.logo, [line.trim()]));
            info = null;
        }
    }
    return unique(entries);
}

function unique(entries) {
    const channels = new Map();
    for (const entry of entries) {
        if (!entry) continue;
        const existing = channels.get(entry.id);
        if (existing) existing.sources = Array.from(new Set(existing.sources.concat(entry.sources)));
        else channels.set(entry.id, entry);
    }
    if (!channels.size) throw new Error('Catálogo vacío');
    return Array.from(channels.values());
}

async function loadCatalog(country, get) {
    if (country !== 'es') {
        return parseM3u((await get('https://iptv-org.github.io/iptv/countries/' + country + '.m3u', mib)).toString('utf8'));
    }
    let entries;
    try { entries = parseCatalog((await get(catalogUrl, 2 * mib)).toString('utf8')); }
    catch (_) { entries = parseMarkdown((await get(catalogFallback, mib)).toString('utf8')); }
    const existing = new Set(entries.map((item) => key(item.name)));
    const missing = Object.keys(atres).filter((id) => !existing.has(id));
    entries.splice(2, 0, ...missing.map((id) => channel(atres[id][0], id, categories[0], '', [])));
    return unique(entries);
}

async function resolveSources(item, get) {
    const entry = atres[key(item.name)];
    if (!entry || item.sources.length) return item.sources;
    const host = 'https://api.atresplayer.com';
    let url = host + '/client/v1/page/channel/' + entry[1];
    const visited = new Set();
    for (let i = 0; i < 6 && url; i++) {
        if (!url.startsWith(host + '/') || visited.has(url)) break;
        visited.add(url);
        const data = JSON.parse(await get(url, 512 * 1024));
        if (data.drm || data.geoblocked || data.rightsBroadcast === false) break;
        const live = (Array.isArray(data.sourcesLive) ? data.sourcesLive : []).filter((source) =>
            !source.drm && !source.licenseUrl && !source.keySystems).map((source) => mediaUrl(source.src)).filter(Boolean);
        if (live.length) return live;
        const row = (Array.isArray(data.itemRows) ? data.itemRows : []).find((item) =>
            !item.geoblocked && item.rightsBroadcast !== false && item.link && item.link.href);
        const link = data.urlVideo || data.rowLive || (row && row.link.href) || (data.linkLive && data.linkLive.href);
        if (!link) break;
        const target = new URL(link, url);
        if (target.origin !== host && data.urlVideo && /\.(?:m3u8|mpd)$/i.test(target.pathname)) {
            const source = mediaUrl(target.href);
            return source ? [source] : [];
        }
        url = target.href;
    }
    return [];
}

function inflate(bytes) {
    return new Promise((resolve, reject) => {
        const decoder = zlib.createGunzip();
        const chunks = [];
        let size = 0;
        decoder.on('data', (chunk) => {
            size += chunk.length;
            if (size > 16 * mib) decoder.destroy(new Error('EPG demasiado grande'));
            else chunks.push(chunk);
        });
        decoder.on('error', reject);
        decoder.on('end', () => resolve(Buffer.concat(chunks)));
        decoder.end(bytes);
    });
}

function reader(buffer, magic, version) {
    let position = 0;
    function int() {
        const value = buffer.readInt32BE(position);
        position += 4;
        return value;
    }
    if (int() !== magic || int() !== version) throw new Error('Formato EPG desconocido');
    function count(max) {
        const size = int();
        if (size < 0 || size > max) throw new Error('Longitud EPG no válida');
        return size;
    }
    return {
        count,
        array: (max, item) => Array.from({ length: count(max) }, item),
        time() {
            const value = buffer.readInt32BE(position) * 0x100000000 + buffer.readUInt32BE(position + 4);
            position += 8;
            return value;
        },
        string() {
            const size = count(64 * 1024);
            if (size > buffer.length - position) throw new Error('EPG incompleta');
            const value = buffer.toString('utf8', position, position + size);
            position += size;
            return value;
        }
    };
}

function parseGuide(bytes) {
    const read = reader(bytes, 0x54444744, 2);
    const downloadedAt = read.time();
    const start = read.time();
    const end = read.time();
    const schedules = read.array(4000, () => read.array(10000, () => ({
        title: read.string(), description: read.string(), category: read.string(), icon: read.string(),
        start: read.time(), end: read.time()
    })));
    const aliases = new Map(read.array(20000, () => [read.string(), schedules[read.count(schedules.length)]]));
    return { downloadedAt, start, end, aliases };
}

function parseFanart(bytes) {
    const read = reader(bytes, 0x54444641, 1);
    return new Map(read.array(100000, () => [key(read.string()) + ':' + read.time(), mediaUrl(read.string())]));
}

function version(country, get) {
    return get(guideRoot + country + '/version.json', 32 * 1024).then((bytes) => JSON.parse(bytes));
}

async function dataset(country, name, hash, cached, get) {
    const valid = (bytes) => bytes && crypto.createHash('sha256').update(bytes).digest('hex') === hash;
    if (valid(cached)) return cached;
    const bytes = await get(guideRoot + country + '/' + name + '.bin.gz', 4 * mib);
    if (!valid(bytes)) throw new Error('La huella de ' + name + ' no coincide');
    return bytes;
}

function schedule(guide, item) {
    if (!guide || !item) return [];
    return guide.aliases.get(item.epg) || guide.aliases.get(item.id) || guide.aliases.get(key(item.name)) || [];
}

function currentIndex(programs, now) {
    const index = programs.findIndex((program) => program.end > now);
    return index === -1 ? Math.max(0, programs.length - 1) : index;
}

module.exports = {
    countries, zones, categories, mediaUrl, key, loadCatalog, parseCatalog, parseMarkdown, parseM3u, parseGuide,
    parseFanart, inflate, version, dataset, schedule, currentIndex, resolveSources
};
