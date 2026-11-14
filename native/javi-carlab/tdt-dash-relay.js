'use strict';

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const { mediaUrl } = require('./tdt-catalog');
const { selectDash, segmentParameters } = require('./tdt-dash');
const dashHls = require('./tdt-dash-hls');

// This relay lives in the existing OAP-UID network process. Only registered
// segment templates are exposed, behind a per-playback random capability.
function createDashRelay(lookup, request = https.request, ca) {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 2, maxCachedSessions: 8 });
    const prefix = '/dash/' + crypto.randomBytes(24).toString('hex') + '/';
    const assets = new Map(), pending = new Set();
    let origin, closed = false;
    function reply(res, code) { if (!res.headersSent) { res.writeHead(code); res.end(); } else res.destroy(); }
    function upstream(target, req, res, limit, done, redirects = 3) {
        const address = mediaUrl(target);
        if (closed || !address.startsWith('https://')) { reply(res, 502); return; }
        const url = new URL(address);
        const headers = { 'Accept-Encoding': 'identity', 'User-Agent': 'BMWLauncher/0.2' };
        if (req.headers.range && /^bytes=\d+-\d*$/.test(req.headers.range)) headers.Range = req.headers.range;
        let body, finished = false;
        const remote = request({ protocol: 'https:', hostname: url.hostname, path: url.pathname + url.search,
            lookup, ca, agent, rejectUnauthorized: true, headers, method: 'GET' }, (incoming) => {
            body = incoming;
            if ([301, 302, 303, 307, 308].includes(body.statusCode) && body.headers.location && redirects) {
                const location = body.headers.location;
                body.resume(); cleanup(); remote.destroy();
                try { upstream(new URL(location, url).href, req, res, limit, done, redirects - 1); }
                catch (_) { reply(res, 502); }
                return;
            }
            if (![200, 206].includes(body.statusCode)) { body.resume(); reply(res, body.statusCode === 404 ? 404 : 502); cleanup(); remote.destroy(); return; }
            if (body.headers['content-encoding'] && body.headers['content-encoding'] !== 'identity') {
                reply(res, 502); cleanup(); remote.destroy(); return;
            }
            let size = 0;
            const chunks = [];
            body.on('error', () => { reply(res, 502); cleanup(); remote.destroy(); });
            body.on('aborted', () => { reply(res, 502); cleanup(); remote.destroy(); });
            body.on('data', (chunk) => {
                size += chunk.length;
                if (size > limit) { reply(res, 502); cleanup(); remote.destroy(); body.destroy(); }
                else if (done) chunks.push(chunk);
            });
            body.on('end', () => {
                if (finished) return;
                cleanup();
                if (done) {
                    try { done(Buffer.concat(chunks), url.href); }
                    catch (_) { reply(res, 422); }
                }
            });
            if (!done) {
                const outgoing = { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', Connection: 'close' };
                ['content-length', 'content-range', 'accept-ranges'].forEach((name) => { if (body.headers[name]) outgoing[name] = body.headers[name]; });
                res.writeHead(body.statusCode, outgoing);
                body.pipe(res);
            }
        });
        const timer = setTimeout(() => { reply(res, 504); cleanup(); remote.destroy(); if (body) body.destroy(); }, 10000);
        const cancel = () => { cleanup(); remote.destroy(); if (body) body.destroy(); res.destroy(); };
        function cleanup() {
            if (finished) return;
            finished = true; clearTimeout(timer); pending.delete(cancel); res.removeListener('close', cancel);
        }
        pending.add(cancel); res.once('close', cancel);
        remote.on('error', () => { reply(res, 502); cleanup(); });
        remote.end();
    }
    function register(template) {
        const parameters = segmentParameters(template);
        const id = crypto.createHash('sha256').update(template).digest('hex').slice(0, 32);
        const now = Date.now();
        assets.forEach((asset, key) => { if (now - asset.at > 120000) assets.delete(key); });
        if (!assets.has(id) && assets.size >= 64) throw new Error('Demasiadas plantillas');
        assets.set(id, { template, parameters, at: now });
        return origin + prefix + 'asset/' + id + (parameters.length ? '?' + parameters.map((p) => p.key + '=' + p.match).join('&') : '');
    }
    return {
        attach(base) { origin = base; return base + prefix + 'master.m3u8?source='; },
        handle(req, res) {
            if (!req.url.startsWith('/dash/')) return false;
            if (closed || !req.url.startsWith(prefix) || req.method !== 'GET') { reply(res, 403); return true; }
            if (pending.size >= 8) { reply(res, 503); return true; }
            let url;
            try { url = new URL(req.url, origin); } catch (_) { reply(res, 400); return true; }
            if (['master.m3u8', 'video.m3u8', 'audio.m3u8'].some((name) => url.pathname === prefix + name)) {
                const source = url.searchParams.get('source');
                upstream(source, req, res, 256 * 1024, (bytes, finalUrl) => {
                    const kind = url.pathname.slice(prefix.length).split('.')[0];
                    let playlists;
                    try {
                        playlists = dashHls(bytes, finalUrl,
                            (target) => register(target).replace(/(\/asset\/[a-f0-9]{32})(?=\?|$)/, '$1.mp4'),
                            (track) => origin + prefix + track + '.m3u8?source=' + encodeURIComponent(source));
                    } catch (error) {
                        if (kind !== 'master') throw error;
                        // Preserve the existing bounded DASH path for layouts that
                        // cannot be represented faithfully as an HLS timeline.
                        selectDash(bytes, finalUrl, (target) => target);
                        res.writeHead(302, { Location: origin + prefix + 'manifest.mpd?source=' + encodeURIComponent(source), Connection: 'close' });
                        res.end();
                        return;
                    }
                    const body = playlists[kind];
                    if (!body) { reply(res, 404); return; }
                    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', Connection: 'close' });
                    res.end(body);
                });
            } else if (url.pathname === prefix + 'manifest.mpd') {
                const source = url.searchParams.get('source');
                upstream(source, req, res, 256 * 1024, (bytes, finalUrl) => {
                    const xml = selectDash(bytes, finalUrl, register);
                    // FFmpeg's DASH reader requires a finite, complete MPD;
                    // explicit length also avoids its chunked-EOF ambiguity.
                    res.writeHead(200, { 'Content-Type': 'application/dash+xml', 'Content-Length': Buffer.byteLength(xml), 'Cache-Control': 'no-store', Connection: 'close' });
                    res.end(xml);
                });
            } else {
                const asset = assets.get(url.pathname.slice((prefix + 'asset/').length).replace(/\.mp4$/, ''));
                if (!url.pathname.startsWith(prefix + 'asset/') || !asset) { reply(res, 404); return true; }
                let target = asset.template;
                for (const p of asset.parameters) {
                    const value = url.searchParams.get(p.key);
                    if (!/^\d{1,24}$/.test(value || '')) { reply(res, 400); return true; }
                    target = target.replace(new RegExp('\\$' + p.key + '(?:%0\\d{1,2}d)?\\$', 'g'), value);
                }
                upstream(target, req, res, 16 * 1024 * 1024);
            }
            return true;
        },
        close() { closed = true; pending.forEach((cancel) => cancel()); assets.clear(); agent.destroy(); }
    };
}

module.exports = createDashRelay;
