'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createWeather, refreshMs } = require('../../native/javi-carlab/weather-location');
const { createData, parseWeather, weatherUrl } = require('../../native/javi-carlab/drivehub-data');
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };
const point = { latitude: 40.4168, longitude: -3.7038 };
const moved = { latitude: 40.4368, longitude: -3.7038 };
function forecast(temp = 20) {
    const time = '2026-11-13T13:00';
    return Buffer.from(JSON.stringify({ current: { time, temperature_2m: temp, weather_code: 1, is_day: 1 },
        hourly: { time: [time], precipitation: [0], precipitation_probability: [10] },
        daily: { time: [], temperature_2m_max: [24], temperature_2m_min: [18], sunrise: [], sunset: [] } }));
}
function setup(get, cache) {
    let now = 1000000;
    const requests = [], changes = [], stores = [];
    const weather = createWeather({ url: weatherUrl, parse: parseWeather, cache, now: () => now,
        get: (url) => { requests.push(new URL(url)); return get ? get() : forecast(); }, store: (v) => stores.push(v)
    }, (value, status) => changes.push({ value, status }));
    return { weather, requests, changes, stores, advance: (ms) => { now += ms; },
        update: (location = point, visible = true) => weather.update(location, now, visible), snapshot: () => weather.snapshot(now), now: () => now };
}
test('weather waits for valid car GPS and uses that location, never a default city', async () => {
    const f = setup(); f.update(null); f.update({ latitude: 91, longitude: 0 }); await settle(); assert.equal(f.requests.length, 0);
    f.update(); await settle(); assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].searchParams.get('latitude'), '40.417'); assert.equal(f.snapshot().name, 'Ubicación actual');
    f.update(null); assert.equal(f.snapshot(), undefined); assert.equal(f.changes.at(-1).status, 'location'); f.weather.close();
});
test('weather refreshes every ten minutes and after one kilometre, with a minute cadence', async () => {
    const f = setup(); f.update(); await settle();
    f.advance(60000); f.update({ latitude: point.latitude + .001, longitude: point.longitude }); await settle(); assert.equal(f.requests.length, 1);
    f.advance(refreshMs - 60000); f.update(); await settle(); assert.equal(f.requests.length, 2);
    f.advance(60000); f.update(moved); assert.equal(f.snapshot(), undefined); await settle();
    assert.equal(f.requests.length, 3); assert.equal(f.requests[2].searchParams.get('latitude'), '40.437'); f.weather.close();
});
test('one pending forecast cannot overwrite a new location or the hidden session', async () => {
    let resolve; const f = setup(() => new Promise((r) => { resolve = r; }));
    f.update(); await settle(); f.advance(60000); f.update(moved); f.update(moved);
    assert.equal(f.requests.length, 1); resolve(forecast(30)); await settle(); assert.equal(f.snapshot(), undefined); assert.equal(f.stores.length, 0);
    f.update(moved); await settle(); assert.equal(f.requests.length, 2);
    f.weather.suspend(); resolve(forecast()); await settle(); assert.equal(f.stores.length, 0);
    f.update(moved); await settle(); assert.equal(f.requests.length, 3); f.weather.close(); resolve(forecast()); await settle(); assert.equal(f.stores.length, 0);
});
test('failed forecasts retain only nearby recent data, retry without storms and expire', async () => {
    let fail = false; const f = setup(() => fail ? Promise.reject(new Error('OFFLINE')) : forecast());
    f.update(); await settle(); fail = true; f.advance(refreshMs); f.update(); await settle();
    assert.equal(f.changes.at(-1).status, 'offline'); assert.equal(f.snapshot().temp, 20);
    for (let i = 0; i < 30; i++) f.update(); await settle(); assert.equal(f.requests.length, 2);
    f.advance(60000); f.update(); await settle(); assert.equal(f.requests.length, 3);
    f.advance(refreshMs); f.update(); await settle(); assert.equal(f.snapshot(), undefined); f.weather.close();
});
test('persistent forecasts require coordinates and age; old fixed-city caches cannot become current weather', async () => {
    const value = parseWeather(JSON.parse(forecast()), 'Ubicación actual');
    const old = setup(null, { at: 1000000, value }); old.update(); await settle(); assert.equal(old.requests.length, 1); old.weather.close();
    const fresh = setup(null, { at: 999999, location: point, value }); fresh.update(); await settle(); assert.equal(fresh.requests.length, 0);
    fresh.update(moved); assert.equal(fresh.snapshot(), undefined); fresh.advance(60000); fresh.update(moved); await settle(); assert.equal(fresh.requests.length, 1); fresh.weather.close();
});
test('DriveHub and cockpit receive the same forecast and closing prevents further requests', async () => {
    let now = 1000000; const requests = [];
    const data = createData({ now: () => now, get: (url) => { requests.push(url); return Promise.resolve(url.includes('open-meteo') ? forecast() : Buffer.from('<rss><channel/></rss>')); } }, () => {});
    data.refresh(now, point); await settle(); assert.equal(data.data.weather, data.weatherSnapshot(now)); assert.equal(data.data.weather.temp, 20);
    data.refresh(now, null); assert.equal(data.data.weather, undefined);
    data.close(); now += refreshMs; data.refresh(now, moved); await settle(); assert.equal(requests.filter((url) => url.includes('open-meteo')).length, 1);
});
