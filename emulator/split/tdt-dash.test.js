'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { selectDash } = require('../../native/javi-carlab/tdt-dash');
const createRelay = require('../../native/javi-carlab/tdt-dash-relay');
const { createPlayer } = require('../../native/javi-carlab/tdt-player');

const manifest = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="1970-01-01T00:00:00Z" minimumUpdatePeriod="PT2S">
 <BaseURL>https://cdn.example.org/live/</BaseURL><Period start="PT0S">
  <AdaptationSet mimeType="video/mp4" codecs="avc1.4D401F">
   <SegmentTemplate timescale="600" startNumber="12345" media="video-$RepresentationID$-$Time$.m4s" initialization="init-$RepresentationID$.mp4">
    <SegmentTimeline><S t="1234567890120" d="2400" r="10"/></SegmentTimeline>
   </SegmentTemplate>
   <Representation id="v720" width="1280" height="720" bandwidth="2000000"/>
   <Representation id="v360" width="640" height="360" bandwidth="400000"/>
   <Representation id="v1080" width="1920" height="1080" bandwidth="6000000"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
   <SegmentTemplate duration="192000" timescale="48000" media="$RepresentationID$-$Number%05d$.m4s" initialization="$RepresentationID$.mp4"/>
   <Representation id="english" bandwidth="128000"/>
  </AdaptationSet>
  <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="es">
   <SegmentTemplate duration="192000" timescale="48000" media="$RepresentationID$-$Number%05d$.m4s" initialization="$RepresentationID$.mp4"/>
   <Representation id="spanish" bandwidth="128000"/>
  </AdaptationSet>
 </Period>
</MPD>`;
const source = 'https://channel.example.org/manifest.mpd';

test('DASH keeps one fitting AVC representation and Spanish audio, preserving the exact timeline', () => {
    const urls = [];
    const result = selectDash(manifest, source, (url) => { urls.push(url); return url; });
    assert.equal((result.match(/<Representation /g) || []).length, 2);
    assert(result.includes('id="v360"')); assert(result.includes('id="spanish"'));
    assert(!result.includes('v720')); assert(!result.includes('english'));
    assert(result.includes('t="1234567890120" d="2400" r="10"'));
    assert(result.includes('startNumber="12345"'));
    assert(urls.includes('https://cdn.example.org/live/video-v360-$Time$.m4s'));
    assert(urls.includes('https://cdn.example.org/live/spanish-$Number%05d$.m4s'));
});

test('DASH refuses hostile XML, unsupported layouts and non-HTTPS media', () => {
    for (const xml of ['<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + manifest,
        manifest.replace('<Period start="PT0S">', '<Period></Period><Period start="PT0S">'),
        manifest.replace('<SegmentTemplate timescale=', '<ContentProtection/><SegmentTemplate timescale='),
        manifest.replace('https://cdn.example.org', 'http://cdn.example.org'),
        manifest.replace('$Time$.m4s', '$Time$-$Time%05d$.m4s'),
        manifest.replace('$Time$.m4s', '$Time%099d$.m4s'), 'x'.repeat(262145)]) {
        assert.throws(() => selectDash(xml, source, (url) => url));
    }
});

test('DASH ignores malformed dimensions instead of selecting their positive product', () => {
    const xml = manifest.replace('width="640" height="360"', 'width="-640" height="-360"');
    const result = selectDash(xml, source, (url) => url);
    assert(!result.includes('id="v360"'));
    assert(result.includes('id="v720"'), 'smallest valid fallback when no video fits');
});

async function fixture(t, transport) {
    const relay = createRelay(undefined, transport);
    const server = http.createServer((req, res) => { if (!relay.handle(req, res)) { res.writeHead(404); res.end(); } });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const prefix = relay.attach('http://127.0.0.1:' + server.address().port);
    t.after(() => { relay.close(); server.close(); });
    return { relay, prefix };
}
function get(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            const chunks = []; res.on('data', (b) => chunks.push(b));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
            res.on('error', reject);
        }).on('error', reject);
    });
}
function transport(serve) {
    return (options, callback) => {
        const req = new EventEmitter(); req.destroyed = false;
        req.destroy = () => { req.destroyed = true; };
        req.end = () => setImmediate(() => {
            if (req.destroyed) return;
            const res = new PassThrough(); res.headers = {}; res.statusCode = 200;
            const value = serve(options, res);
            callback(res); if (value !== undefined) res.end(value);
        });
        return req;
    };
}

test('DASH relay verifies upstream TLS, refreshes the MPD and only serves registered numeric segments', async (t) => {
    const upstream = []; let refresh = 0;
    const { prefix } = await fixture(t, transport((options) => {
        assert.equal(options.rejectUnauthorized, true); assert.equal(options.protocol, 'https:');
        upstream.push(options.hostname + options.path);
        if (options.path === '/manifest.mpd') return manifest.replace('1234567890120', String(1234567890120 + refresh++ * 2400));
        return 'media bytes';
    }));
    const first = await get(prefix + encodeURIComponent(source));
    assert.equal(first.status, 200);
    assert.equal(Number(first.headers['content-length']), Buffer.byteLength(first.body));
    const video = /media="([^"]*Time[^"]*)"/.exec(first.body)[1].replace(/&amp;/g, '&');
    assert(video.startsWith('http://127.0.0.1:'));
    assert.equal((await get(video.replace('$Time$', '1234567890120'))).body, 'media bytes');
    assert(upstream.includes('cdn.example.org/live/video-v360-1234567890120.m4s'));
    const count = upstream.length;
    assert.equal((await get(video.replace('$Time$', '..%2Fsecret'))).status, 400);
    assert.equal(upstream.length, count, 'invalid substitutions never reach the network');
    assert.equal((await get(prefix.replace(/\/dash\/[^/]+\//, '/dash/wrong/') + encodeURIComponent(source))).status, 403);
    const second = await get(prefix + encodeURIComponent(source));
    assert(second.body.includes('1234567892520'), 'live timelines must be refreshed');
    assert.equal((await get(prefix + encodeURIComponent('https://127.0.0.1/private'))).status, 502);
});

test('DASH relay rejects redirect downgrades and cancels outstanding reads when closed', async (t) => {
    let active, cancelled = false;
    const { prefix, relay } = await fixture(t, (options, callback) => {
        const req = new EventEmitter(); req.destroy = () => { cancelled = true; };
        req.end = () => setImmediate(() => {
            if (options.path.includes('redirect')) {
                const res = new PassThrough(); res.statusCode = 302; res.headers = { location: 'http://unsafe.example.org/data' };
                callback(res); res.end();
            } else active = req;
        });
        return req;
    });
    assert.equal((await get(prefix + encodeURIComponent('https://channel.example.org/redirect'))).status, 502);
    cancelled = false;
    const pending = get(prefix + encodeURIComponent(source)).catch(() => null);
    for (let i = 0; i < 50 && !active; i++) await new Promise((r) => setTimeout(r, 5));
    assert(active); relay.close(); assert(cancelled);
    await pending;
});

test('player selects the local DASH relay without global TLS options or a proxy loop', async (t) => {
    let observed;
    const network = { url: 'http://tdt:secret@127.0.0.1:1234', dashUrl: 'http://127.0.0.1:1234/dash/key/manifest.mpd?source=', close() {} };
    const player = createPlayer({ video() {} }, { caFile: 'test-ca', proxy: () => network, get: () => Promise.resolve(Buffer.from(manifest)),
        spawnProcess(command, args, options) {
            observed = { args, options };
            const child = new EventEmitter(); child.kill = () => {};
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child;
        } });
    t.after(() => player.stop()); player.ready({ video: true }); player.start([source], () => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert(observed); assert(observed.args.includes(network.dashUrl + encodeURIComponent(source)));
    assert(!observed.args.includes('-tls_verify')); assert(!observed.args.includes('-http_proxy'));
    assert(observed.args.includes('http,tcp')); assert(!observed.args.includes('-re'));
    assert.equal(observed.options.env.no_proxy, '127.0.0.1');
});
