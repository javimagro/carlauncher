'use strict';

const crypto = require('crypto');
const https = require('https');
const { URL } = require('url');
const { lookupForUplink } = require('./drivehub-network');

const api = 'https://services-ott-prod-fe.mediaset.net/esp';
const app = 'web//mediasetesp-web/1.2.3';
const origin = 'https://www.mitele.es';
const channelCodes = Object.freeze({ cuatro: 'CT', telecinco: 'T5', fdf: 'FD',
    energy: 'EN', divinity: 'DV', bemad: 'BM', boing: 'BO' });

function post(address, body, authorization, lookup, track) {
    const url = new URL(address), payload = Buffer.from(JSON.stringify(body));
    const headers = { Origin: origin, Referer: origin + '/', Accept: 'application/json',
        'Content-Type': 'application/json', 'Content-Length': payload.length, 'User-Agent': 'Mozilla/5.0' };
    if (authorization) headers.Authorization = authorization;
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: url.hostname, path: url.pathname + url.search,
            method: 'POST', lookup, headers }, (res) => {
            if (res.statusCode < 200 || res.statusCode >= 300) {
                res.destroy();
                return reject(new Error('mediaset-http-' + res.statusCode));
            }
            const chunks = [];
            let size = 0;
            res.on('data', chunk => {
                size += chunk.length;
                if (size > 128 * 1024) req.destroy(new Error('mediaset-size'));
                else chunks.push(chunk);
            });
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('mediaset-aborted')));
            res.on('end', () => {
                try { resolve(JSON.parse(Buffer.concat(chunks))); }
                catch (_) { reject(new Error('mediaset-json')); }
            });
        });
        const timer = setTimeout(() => req.destroy(new Error('mediaset-timeout')), 4000);
        req.once('close', () => clearTimeout(timer));
        req.once('error', reject);
        if (track) track(req);
        req.end(payload);
    });
}

async function resolveMediaset(code, request = post) {
    if (Object.values(channelCodes).indexOf(code) < 0) throw new Error('mediaset-channel');
    const client = crypto.randomBytes(16);
    client[6] = (client[6] & 15) | 64;
    client[8] = (client[8] & 63) | 128;
    const clientId = client.toString('hex').replace(/^(........)(....)(....)(....)/, '$1-$2-$3-$4-');
    const login = await request(api + '/idm/v3.0/anonymous/login', { client_id: clientId, appName: app });
    const session = login && login.isOk && login.response;
    const valid = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
    if (!session || !valid(session.sid) || !valid(session.beToken)) throw new Error('mediaset-session');
    const playback = await request(api + '/playback/v3.0/check?sid=' + encodeURIComponent(session.sid), {
        channelCode: code, streamType: 'LIVE', delivery: 'Streaming', createDevice: true, overrideAppName: app
    }, 'Basic ' + Buffer.from(':' + session.beToken).toString('base64'));
    const dai = playback && playback.isOk && playback.response && playback.response.dai;
    if (!dai || typeof dai.assetKey !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(dai.assetKey))
        throw new Error('mediaset-playback');
    const stream = await request('https://dai.google.com/linear/v1/hls/event/' + dai.assetKey + '/stream', {});
    const value = stream && (stream.stream_manifest || stream.hls_master_playlist);
    if (typeof value !== 'string' || value.length > 8192) throw new Error('mediaset-manifest');
    const url = new URL(value);
    if (url.origin !== 'https://directos.mediasetinfinity.es' || url.username || url.password || !/\.m3u8$/i.test(url.pathname))
        throw new Error('mediaset-manifest');
    return [url.href];
}

function startMediaset(code, lookup) {
    let request, cancelled = false;
    const result = resolveMediaset(code, (url, body, auth) => {
        if (cancelled) throw new Error('mediaset-cancelled');
        return post(url, body, auth, lookup, req => { request = req; });
    });
    return { result, cancel() { cancelled = true; if (request) request.destroy(new Error('mediaset-cancelled')); } };
}

if (require.main === module) {
    Promise.resolve().then(() => startMediaset(process.argv[2], lookupForUplink()).result)
        .then(sources => process.stdout.write(JSON.stringify(sources)), () => { process.exitCode = 1; });
}

module.exports = { channelCodes, resolveMediaset, startMediaset };
