'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createDriveHub, width, height, cards, viewport, dailyChart } = require('../../native/javi-carlab/drivehub-state');
const { fitArea } = require('../../native/javi-carlab/layout');
const { loadArtwork, loadNews, parseFeed, parseWeather, networkDetail } = require('../../native/javi-carlab/drivehub-data');
const { appUid, authorizeApp } = require('../../native/javi-carlab/drivehub-uplink');
const { consume } = require('../../native/javi-carlab/controller-input');
const { sample } = require('../../apps/javi_carlauncher/controller');
const createSession = require('../../native/javi-carlab/drivehub-session');
const fonts = require('../../native/javi-carlab/vendor/kit_fonts');

function panel() {
    let now = 0;
    const drive = createDriveHub(() => {}, () => now);
    return {
        drive,
        settle() { now += 250; return drive.position(); },
        swipe(x, y, endX, endY) {
            drive.touch('down', x, y);
            drive.touch('move', (x + endX) / 2, (y + endY) / 2);
            drive.touch('up', endX, endY);
        },
        wheel(knob, press = 0, tilt = 0) { drive.controller({ knob, press, tilt }); }
    };
}

test('horizontal swipe tracks the finger and snaps to the paired and full-width pages', () => {
    const { drive, settle, swipe } = panel();
    drive.touch('down', 1450, 220);
    drive.touch('move', 1220, 220);
    assert.equal(drive.position(), 230);
    drive.touch('up', 1030, 220);
    assert.equal(settle(), cards[1].x);
    assert.equal(drive.state.selected, 1);
    swipe(1450, 220, 1000, 220);
    assert.equal(settle(), cards[3].x);
    assert.equal(drive.state.selected, 3);
    swipe(1010, 220, 1530, 220);
    assert.equal(settle(), cards[1].x);
    assert.equal(drive.state.selected, 2);
    swipe(350, 220, 250, 220);
    assert.equal(settle(), cards[1].x);
});

test('FrontCCU wraps its counter and treats long press and repeated tilt as one action', () => {
    const { drive, settle, wheel } = panel();
    wheel(65535);
    wheel(0);
    assert.equal(drive.state.selected, 1);
    wheel(1);
    assert.equal(settle(), cards[1].x);
    wheel(1, 1);
    assert.equal(drive.state.weatherPage, 'rain');
    wheel(1, 2);
    assert.equal(drive.state.weatherPage, 'rain');
    wheel(1, 0, 7);
    wheel(1, 0, 8);
    assert.equal(drive.state.weatherPage, 'summary');
    wheel(1, 0, 10);
    assert.equal(settle(), cards[1].x);
    assert.equal(drive.state.selected, 2);
    wheel(1, 0, 4);
    assert.equal(drive.state.selected, 2);
    wheel(2);
    assert.equal(settle(), cards[3].x);
    wheel(1);
    assert.equal(settle(), cards[1].x);
});

test('the rain chart selects a day and article navigation stops at either end', () => {
    const { drive, settle, swipe, wheel } = panel();
    swipe(1480, 220, 1050, 220);
    settle();
    const weatherX = viewport.x + cards[2].x - cards[1].x;
    swipe(weatherX + 120, 350, weatherX + 120, 190);
    assert.equal(drive.state.selected, 2);
    assert.equal(drive.state.weatherPage, 'rain');
    const x = weatherX + dailyChart.x + dailyChart.w / 2;
    const y = viewport.y + dailyChart.y + 35;
    drive.touch('down', x, y);
    drive.touch('up', x, y);
    assert.equal(drive.state.weatherDay, 3);
    swipe(1480, 220, 1050, 220);
    settle();
    drive.setArticleCount(2);
    wheel(0, 0, 1);
    assert.equal(drive.state.article, 0);
    wheel(0, 0, 7);
    assert.equal(drive.state.article, 1);
    swipe(1150, 350, 1150, 190);
    assert.equal(drive.state.article, 1);
    swipe(1150, 190, 1150, 350);
    assert.equal(drive.state.article, 0);
});

test('RSS keeps Spanish text and recovers image metadata from the article', () => {
    const xml = '<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item><title>Árbol &amp; lluvia</title>'
        + '<description><![CDATA[<p>Un d&iacute;a lluvioso.</p>]]></description><link>https://ejemplo.es/lluvia</link>'
        + '<media:content url="https://ejemplo.es/lluvia.jpg" type="image/jpeg"/></item></channel></rss>';
    const [article] = parseFeed(xml, 'Ejemplo');
    assert.equal(article.title, 'Árbol & lluvia');
    assert.equal(article.summary, 'Un día lluvioso.');
    assert.equal(article.image, 'https://ejemplo.es/lluvia.jpg');
});

test('Open-Meteo groups hourly precipitation by its local calendar day', () => {
    const weather = parseWeather({
        current: { time: '2026-11-11T22:15', temperature_2m: 13, weather_code: 0, is_day: 0 },
        daily: { time: ['2026-11-11', '2026-11-12'], temperature_2m_max: [13], temperature_2m_min: [9],
            sunrise: ['2026-11-11T07:56'], sunset: ['2026-11-11T17:59'], precipitation_sum: [0.8, 2.1] },
        hourly: { time: ['2026-11-11T22:00', '2026-11-11T23:00', '2026-11-12T00:00', '2026-11-12T01:00'],
            temperature_2m: [13, 12, 11, 10], weather_code: [0, 3, 63, 63],
            is_day: [0, 0, 0, 0], precipitation_probability: [0, 60, 90, 98], precipitation: [0, 0.8, 1, 1.1] }
    }, 'Madrid');
    assert.equal(weather.kind, 'night');
    assert.equal(weather.hours[1].time, '00:00');
    assert.deepEqual(weather.dailyRain.map((day) => day.hours.map((hour) => hour.mm)), [[0, 0.8], [1, 1.1]]);
});

test('packaged artwork and font cover the dashboard states and Spanish glyphs', () => {
    const art = loadArtwork();
    for (const name of ['weather-rain', 'icon-rain', 'news', 'radio', 'battery-low', 'battery-mid', 'battery-high', 'range']) {
        assert.ok(art(name).data.length > 0, name);
    }
    const sample = 'Energía, precipitación, próximo, día, ñ, Á, ¿qué?';
    const atlas = fonts.get('label', 20, sample);
    for (const glyph of sample) assert.ok(atlas.glyphs[glyph.codePointAt(0)], glyph);
});

test('the app uses the full default panoramic content area on iDrive 8', () => {
    const area = { x: 0, y: 76, w: 2880, h: 764 };
    const fitted = fitArea(area, width, height);
    assert.deepEqual({ x: fitted.x, y: fitted.y, w: fitted.w, h: fitted.h }, area);
});

test('FrontCCU frames from the OAP preserve the rotation and ignore horizontal deflection', () => {
    const frames = [];
    const read = consume((frame) => frames.push(frame));
    const build = (knob, button, deflection) => sample({
        frontRotaryEncoderOperation: knob, frontRotaryEncoderPushButton: button, frontRotaryEncoderDeflection: deflection
    });
    const bytes = Buffer.concat([build(22, 0, 'WEST_KURZ_GEDRUECKT'),
        build(23, 'DREHGEBER_KURZ_GEDRUECKT', 'NORD_KURZ_GEDRUECKT')]);
    assert.equal(build(0xffff, 15, 15), null);
    assert.ok(read(bytes.slice(0, 3)));
    assert.ok(read(bytes.slice(3)));
    assert.deepEqual(frames, [{ knob: 22, press: 0, tilt: 0 }, { knob: 23, press: 1, tilt: 1 }]);
    assert.equal(read(Buffer.alloc(257)), false);
});

test('the rendered session uses OAP rotation when the renderer cannot grab the controller', async (t) => {
    const gpu = new EventEmitter();
    Object.assign(gpu, { place() {}, claim() {}, show() {}, close() {}, grab() { assert.fail('unexpected grab'); } });
    let last;
    gpu.frame = (recording) => { last = recording.words().slice(); };
    const session = createSession(gpu, { area: () => ({ scale: 1 }), fixture: { news: [] } });
    t.after(() => session.close());
    gpu.emit('ready', {}, { controller: false });
    session.show(true);
    const initial = last;
    const turn = (knob, tilt = 0) => ({ knob, press: 0, tilt });
    session.controller(turn(100));
    session.controller(turn(100, 10));
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(last, initial);
    session.controller(turn(101));
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.notDeepEqual(last, initial);
    const beforeExit = last;
    session.show(false);
    session.controller(turn(102));
    await new Promise((resolve) => setTimeout(resolve, 55));
    assert.equal(last, beforeExit);
});

test('the ID8 app can restore only its declared internet access after a queued update', (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'bmwlauncher-uplink-'));
    t.after(() => {
        assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
        assert.match(path.basename(base), /^bmwlauncher-uplink-/);
        fs.rmSync(base, { recursive: true });
    });
    const oap = path.join(base, 'oap');
    const uplink = path.join(base, 'uplink');
    const id = 'javi_carlauncher';
    const registry = path.join(oap, 'oap_12201/security');
    const packageDir = path.join(oap, 'oap_13330/source');
    const packageFile = path.join(packageDir, 'package.json');
    const marker = path.join(uplink, 'apps.d', id);
    fs.mkdirSync(registry, { recursive: true });
    fs.mkdirSync(packageDir, { recursive: true });
    fs.mkdirSync(uplink);
    fs.writeFileSync(path.join(registry, 'uids.txt'), '0=javi_carlauncher\n13331=javi_carlauncher2\n13330 = javi_carlauncher\r\n');
    const uid = appUid(oap, id);
    assert.equal(uid, 13330);
    fs.writeFileSync(packageFile, JSON.stringify({ name: id, mguInternet: false }));
    assert.equal(authorizeApp({ oap, uplink, id, uid }), false);
    assert.equal(fs.existsSync(marker), false);
    fs.writeFileSync(packageFile, JSON.stringify({ name: id, mguInternet: true }));
    assert.equal(authorizeApp({ oap, uplink, id, uid }), true);
    assert.equal(authorizeApp({ oap, uplink, id, uid }), true);
    assert.equal(fs.readFileSync(marker, 'utf8'), id + '\n');
});

test('news retains a network error code when all sources fail', async () => {
    const error = Object.assign(new Error('connection denied'), { code: 'UPLINK_APP' });
    await assert.rejects(loadNews(async () => { throw error; }), { code: 'UPLINK_APP' });
    assert.equal(networkDetail('UPLINK_APP'), 'Acceso a internet de BMWLauncher pendiente');
    assert.equal(networkDetail('ENOTFOUND'), 'Fallo de DNS');
    assert.equal(networkDetail('CERT_HAS_EXPIRED'), 'Fallo al verificar la conexión segura');
});
