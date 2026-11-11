'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const download = require('./drivehub-network.js');
const sax = require('./vendor/sax.js');
const decodeJpeg = require('./vendor/jpeg-decoder.js');
const png = require('./vendor/kit_png.js');
const { makeImage, dropImage } = require('./vendor/kit_record.js');

const defaultLocation = { name: 'Madrid', latitude: 40.4168, longitude: -3.7038 };
const feeds = [
    ['EL PAÍS', 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/portada'],
    ['Xataka', 'https://feeds.weblogssl.com/xataka2'],
    ['Motorpasión', 'https://www.motorpasion.com/index.xml']
];
const weatherInterval = 30 * 60 * 1000;
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
    return {
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
        try { return parseFeed((await get(url, 2 * 1024 * 1024)).toString('utf8'), source); }
        catch (_) { return []; }
    }));
    const seen = new Set();
    const articles = [].concat(...results).sort((a, b) => b.date - a.date).filter((article) => {
        const key = article.title.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 20);
    if (!articles.length) throw new Error('Fuentes de noticias no disponibles');
    return articles;
}

function loadArtwork() {
    const raw = zlib.gunzipSync(fs.readFileSync(path.join(__dirname, 'drivehub-art.rgba.gz')));
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

async function loadPhoto(url, get) {
    const address = new URL(url);
    if (address.hostname === 'imagenes.elpais.com' && address.pathname.startsWith('/resizer/v2/')) {
        address.searchParams.set('width', '640');
    }
    const bytes = await get(address.href, 3 * 1024 * 1024);
    let image;
    if (bytes.toString('hex', 0, 8) === '89504e470d0a1a0a') {
        image = await new Promise((resolve, reject) =>
            png.decodeAsync(bytes, (err, value) => err ? reject(err) : resolve(value)));
    } else {
        const jpg = decodeJpeg(bytes, { maxResolutionInMP: 10, maxMemoryUsageInMB: 48 });
        image = { w: jpg.width, h: jpg.height, data: jpg.data };
    }
    const w = 528;
    const h = 297;
    const scale = Math.max(w / image.w, h / image.h);
    const left = (image.w - w / scale) / 2;
    const top = (image.h - h / scale) / 2;
    const pixels = Buffer.allocUnsafe(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const source = (Math.floor(top + (y + 0.5) / scale) * image.w + Math.floor(left + (x + 0.5) / scale)) * 4;
            const target = (y * w + x) * 4;
            for (let channel = 0; channel < 4; channel++) pixels[target + channel] = image.data[source + channel];
        }
    }
    return makeImage(w, h, pixels);
}

function readJson(file) {
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { return null; }
}

function createData({ cacheFile, configFile, fixture, get = download }, changed) {
    const config = readJson(configFile);
    const location = config && config.location;
    const valid = location && typeof location.name === 'string' && location.name.trim()
        && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90
        && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180;
    const current = valid ? {
        name: location.name.trim().slice(0, 48), latitude: location.latitude, longitude: location.longitude
    } : defaultLocation;
    const saved = readJson(cacheFile);
    const cache = saved && saved.location === JSON.stringify(current) ? saved : { location: JSON.stringify(current) };
    const data = { energy: mockEnergy, city: current.name,
        weather: fixture ? fixture.weather : cache.weather && cache.weather.value,
        news: fixture ? fixture.news : cache.news && cache.news.value,
        weatherStatus: 'loading', newsStatus: 'loading', photo: null };
    const next = { weather: 0, news: 0 };
    let photoUrl;
    let photoRequest = 0;
    let closed = false;

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
            next[name] = Date.now() + interval;
            save();
            changed(name);
        }).catch(() => {
            if (closed) return;
            data[name + 'Status'] = 'offline';
            next[name] = Date.now() + retryInterval;
            changed(name);
        });
    }

    return {
        data,
        refresh(now) {
            if (fixture) return;
            refreshItem('weather', weatherInterval, async () =>
                parseWeather(JSON.parse((await get(weatherUrl(current), 512 * 1024)).toString('utf8')), current.name), now);
            refreshItem('news', newsInterval, () => loadNews(get), now);
        },
        showPhoto(url) {
            if (fixture || url === photoUrl) return;
            photoUrl = url;
            const request = ++photoRequest;
            if (data.photo) { dropImage(data.photo); data.photo = null; }
            if (!url) return;
            loadPhoto(url, get).then((image) => {
                if (closed || request !== photoRequest) { dropImage(image); return; }
                data.photo = image;
                changed('photo');
            }).catch(() => { /* The card already shows its image fallback. */ });
        },
        close() {
            closed = true;
            if (data.photo) dropImage(data.photo);
        }
    };
}

module.exports = { createData, loadArtwork, loadNews, parseFeed, parseWeather, weatherUrl };
