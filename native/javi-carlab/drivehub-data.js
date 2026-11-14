'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const download = require('./drivehub-network.js');
const sax = require('./vendor/sax.js');
const { makeImage, dropImage } = require('./vendor/kit_record.js');
const { createWeather } = require('./weather-location.js');

const feeds = [
    ['EL PAÍS', 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada'],
    ['Xataka', 'https://feeds.weblogssl.com/xataka2'],
    ['Motorpasión', 'https://www.motorpasion.com/index.xml']
];
const newsInterval = 15 * 60 * 1000;
const retryInterval = 2 * 60 * 1000;
const mockEnergy = [
    { label: 'Ahora', soc: 64, range: 248 },
    { label: 'En la parada', soc: 19, range: 74 },
    { label: 'Tras recarga', soc: 80, range: 310 },
    { label: 'En destino', soc: 24, range: 93 }
];

function weatherKind(code, day = 1) {
    if (code >= 95) return 'storm';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 51) return 'rain';
    if (code >= 45) return 'fog';
    if (code >= 2) return 'cloudy';
    return day ? 'sunny' : 'night';
}

function weatherUrl(location) {
    const query = [
        'latitude=' + location.latitude, 'longitude=' + location.longitude, 'timezone=auto', 'forecast_days=7',
        'current=temperature_2m,apparent_temperature,weather_code,precipitation,wind_speed_10m,wind_direction_10m,is_day',
        'hourly=temperature_2m,precipitation_probability,weather_code,is_day,precipitation',
        'daily=temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_sum'
    ];
    return 'https://api.open-meteo.com/v1/forecast?' + query.join('&');
}

function parseWeather(data, name) {
    const { current, hourly, daily } = data;
    if (!current || !hourly || !daily || !Array.isArray(hourly.time) || !Array.isArray(daily.time)
        || typeof current.time !== 'string' || !Number.isFinite(current.temperature_2m)) throw new Error('Pronóstico incompleto');
    const time = (value) => String(value || '').slice(11, 16);
    const hour = hourly.time.findIndex((value) => value.slice(0, 13) === current.time.slice(0, 13));
    if (hour < 0) throw new Error('Pronóstico sin hora actual');
    const days = ['dom.', 'lun.', 'mar.', 'mié.', 'jue.', 'vie.', 'sáb.'];
    const hourlyRain = {};
    hourly.time.forEach((value, i) => {
        const date = value.slice(0, 10);
        if (!hourlyRain[date]) hourlyRain[date] = [];
        hourlyRain[date].push({ label: time(value).slice(0, 2), mm: hourly.precipitation[i] });
    });
    let cockpitIcon = weatherKind(current.weather_code, current.is_day);
    if (current.weather_code <= 2) cockpitIcon = (current.weather_code ? 'partly_cloudy_' : 'clear_') + (current.is_day === 0 ? 'night' : 'day');
    return {
        cockpitIcon,
        name, temp: current.temperature_2m, feels: current.apparent_temperature, rain: current.precipitation,
        wind: current.wind_speed_10m, direction: current.wind_direction_10m,
        probability: hourly.precipitation_probability[hour], kind: weatherKind(current.weather_code, current.is_day),
        high: daily.temperature_2m_max[0], low: daily.temperature_2m_min[0],
        sunrise: time(daily.sunrise[0]), sunset: time(daily.sunset[0]),
        hours: hourly.time.slice(hour + 1, hour + 4).map((value, i) => {
            const index = hour + 1 + i;
            return { time: time(value), temp: hourly.temperature_2m[index], probability: hourly.precipitation_probability[index],
                kind: weatherKind(hourly.weather_code[index], hourly.is_day[index]) };
        }),
        dailyRain: daily.time.map((value, i) => ({
            label: days[new Date(value + 'T12:00:00Z').getUTCDay()],
            date: value.slice(8) + '/' + value.slice(5, 7), mm: daily.precipitation_sum[i], hours: hourlyRain[value] || []
        }))
    };
}

function plain(value) {
    return String(value || '').replace(/<[^>]*>/g, ' ').replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
        if (entity[0] !== '#') return sax.ENTITIES[entity] || ' ';
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }).replace(/\s+/g, ' ').trim();
}

function limitText(text, max) {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const word = cut.lastIndexOf(' ');
    return (word > 0 ? cut.slice(0, word) : cut) + '…';
}

function parseFeed(xml, source) {
    const articles = [];
    const stack = [];
    let article;
    let description = '';
    const parser = sax.parser(true, { trim: false });
    parser.onopentag = ({ name, attributes }) => {
        name = name.toLowerCase();
        stack.push(name);
        if (name === 'item' || name === 'entry') {
            article = { source, title: '', summary: '', image: '', url: '', date: '' };
            description = '';
        }
        if (!article) return;
        if ((name === 'media:content' || name === 'media:thumbnail' || name === 'enclosure')
            && (!attributes.type || attributes.type.startsWith('image/')) && attributes.url && !article.image) {
            article.image = attributes.url;
        }
        if (name === 'link' && attributes.href && (!attributes.rel || attributes.rel === 'alternate')) article.url = attributes.href;
    };
    parser.ontext = parser.oncdata = (value) => {
        if (!article) return;
        const parent = stack[stack.length - 2];
        if (parent !== 'item' && parent !== 'entry') return;
        switch (stack[stack.length - 1]) {
            case 'title': article.title += value; break;
            case 'description': case 'summary': description += value; break;
            case 'content:encoded': case 'content': article.summary += value; break;
            case 'link': article.url += value; break;
            case 'pubdate': case 'published': case 'updated': article.date += value; break;
        }
    };
    parser.onclosetag = (name) => {
        stack.pop();
        if (!article || !/^(item|entry)$/i.test(name)) return;
        const html = description || article.summary;
        if (!article.image) {
            const embedded = /[<]img\b[^>]*\bsrc\s*=\s*["']([^"']+)/i.exec(description + article.summary);
            if (embedded) article.image = plain(embedded[1]);
        }
        article.title = limitText(plain(article.title), 280);
        article.summary = limitText(plain(html), 850);
        article.date = Date.parse(article.date) || 0;
        article.url = article.url.trim();
        if (article.title && article.url) articles.push(article);
        article = undefined;
    };
    parser.write(xml).close();
    return articles;
}

async function loadNews(get = download) {
    const results = await Promise.all(feeds.map(async ([source, url]) => {
        try { return { articles: parseFeed((await get(url, 2 * 1024 * 1024)).toString('utf8'), source) }; }
        catch (error) { return { articles: [], error }; }
    }));
    const seen = new Set();
    const articles = [].concat(...results.map((result) => result.articles)).sort((a, b) => b.date - a.date).filter((article) => {
        const key = article.title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 20);
    if (!articles.length) {
        const failure = results.find((result) => result.error && result.error.code);
        throw failure ? failure.error : new Error('Fuentes de noticias no disponibles');
    }
    return articles;
}

function loadArtwork(file = 'drivehub-art.rgba.gz') {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, file)));
    const start = 4 + raw.readUInt32LE(0);
    const entries = JSON.parse(raw.toString('utf8', 4, start));
    return (name) => {
        const entry = entries[name];
        if (!entry) return null;
        if (!entry.image) {
            const [w, h, offset] = entry;
            entry.image = makeImage(w, h, raw.subarray(start + offset, start + offset + w * h * 4));
        }
        return entry.image;
    };
}

async function loadPhoto(url, get, w = 528, h = 297, contain = false, current = () => true) {
    const address = new URL(url);
    if (address.hostname === 'imagenes.elpais.com' && address.pathname.startsWith('/resizer/v2/')) {
        address.searchParams.set('width', '640');
    }
    const bytes = await get(address.href, 3 * 1024 * 1024);
    if (!current()) throw Object.assign(new Error('IMAGE_CANCELLED'), { code: 'IMAGE_CANCELLED' });
    return makeImage(w, h, await require('./photo-worker.js')(bytes, w, h, contain));
}

function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return null; }
}

function networkDetail(code) {
    if (code === 'UPLINK_OFFLINE') return 'Conexión de la Store no disponible';
    if (code === 'UPLINK_APP') return 'Acceso a internet de BMWLauncher pendiente';
    if (/^(?:UPLINK_DNS|ENOTFOUND|ENODATA|ESERVFAIL|EREFUSED|EAI_AGAIN|ETIMEOUT)$/.test(code)) return 'Fallo de DNS';
    if (/^(?:ERR_TLS_|CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_)/.test(code)) return 'Fallo al verificar la conexión segura';
    if (/^HTTP_\d{3}$/.test(code)) return 'El servidor devolvió ' + code.slice(5);
    if (/^(?:ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|ECONNREFUSED)$/.test(code)) return 'Sin respuesta del servidor';
    if (code === 'UPLINK_WORKER' || code === 'EACCES' || code === 'ENOENT') return 'Conexión de BMWLauncher no disponible';
    return 'Fuente temporalmente no disponible';
}

function createData({ cacheFile, fixture, get = download, photo = loadPhoto, now: clock = Date.now }, changed) {
    const saved = readJson(cacheFile);
    const cache = saved || {};
    const data = { energy: mockEnergy, city: fixture && fixture.weather ? fixture.weather.name : 'Ubicación actual',
        weather: fixture ? fixture.weather : undefined,
        news: fixture ? fixture.news : cache.news && cache.news.value,
        weatherStatus: fixture ? 'ready' : 'location', newsStatus: 'loading', photo: null };
    const next = { news: 0 };
    let photoUrl;
    let photoRequest = 0;
    let photoPending = false;
    let closed = false;
    const weather = createWeather({ get, parse: parseWeather, url: weatherUrl, now: clock, cache: cache.weather,
        store(item) { cache.weather = item; save(); }
    }, (value, status, at) => {
        data.weather = value; data.weatherStatus = status; data.weatherUpdatedAt = at;
        data.weatherDetail = status === 'offline' ? 'No se pudo actualizar el pronóstico' : '';
        changed('weather');
    });

    function save() {
        if (!cacheFile) return;
        try {
            const temporary = cacheFile + '.tmp';
            fs.writeFileSync(temporary, JSON.stringify(cache), { mode: 0o600 });
            fs.renameSync(temporary, cacheFile);
        } catch (_) { /* A failed cache write leaves the in-memory data usable. */ }
    }

    function refreshItem(name, interval, load, now) {
        if (now < next[name]) return;
        const item = cache[name];
        if (item && now < item.at + interval) {
            next[name] = item.at + interval;
            data[name + 'Status'] = 'ready';
            return;
        }
        next[name] = Infinity;
        load().then((value) => {
            if (closed) return;
            cache[name] = { at: Date.now(), value };
            data[name] = value;
            data[name + 'Status'] = 'ready';
            data[name + 'Detail'] = '';
            next[name] = Date.now() + interval;
            save();
            changed(name);
        }).catch((err) => {
            if (closed) return;
            const code = String(err.code || '');
            data[name + 'Status'] = 'offline';
            data[name + 'Detail'] = networkDetail(code);
            console.warn('BMWLauncher: ' + name + ' ' + (/^[A-Z0-9_]{2,45}$/.test(code) ? code : 'SOURCE'));
            next[name] = Date.now() + retryInterval;
            changed(name);
        });
    }

    return {
        data,
        refresh(now, location, visible = true) {
            if (fixture) return;
            weather.update(location, now, visible);
            if (visible && !closed) refreshItem('news', newsInterval, () => loadNews(get), now);
        },
        weatherSnapshot: weather.snapshot,
        suspend() {
            weather.suspend();
            if (photoPending) { photoRequest++; photoPending = false; photoUrl = undefined; }
        },
        showPhoto(url) {
            if (closed || fixture || url === photoUrl) return;
            photoUrl = url;
            const request = ++photoRequest;
            if (data.photo) { dropImage(data.photo); data.photo = null; }
            photoPending = !!url;
            if (!url) return;
            photo(url, get, 528, 297, false, () => !closed && request === photoRequest).then((image) => {
                if (closed || request !== photoRequest) { dropImage(image); return; }
                photoPending = false;
                data.photo = image;
                changed('photo');
            }).catch(() => { if (request === photoRequest) photoPending = false; });
        },
        close() {
            closed = true;
            weather.close();
            if (data.photo) dropImage(data.photo);
        }
    };
}

module.exports = { createData, loadArtwork, loadNews, loadPhoto, parseFeed, parseWeather, weatherUrl, networkDetail };
