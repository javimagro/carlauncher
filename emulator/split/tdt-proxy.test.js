'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const startProxy = require('../../native/javi-carlab/tdt-proxy');

test('proxy returns 407, 403 and 502 with Node 8 writeHead semantics, without crashing', async () => {
    const original = http.ServerResponse.prototype.writeHead;
    // Node 8 returns undefined; modern Node returns this and hides this regression.
    http.ServerResponse.prototype.writeHead = function () { original.apply(this, arguments); };
    let proxy;
    try {
        proxy = await startProxy((host, options, callback) => {
            if (typeof options === 'function') callback = options;
            callback(Object.assign(new Error('test DNS failure'), { code: 'ENOTFOUND' }));
        });
        const address = new URL(proxy.url);
        const authorization = 'Basic ' + Buffer.from(address.username + ':' + address.password).toString('base64');
        const request = (method, auth) => new Promise((resolve, reject) => {
            const req = http.request({ host: address.hostname, port: address.port, method,
                path: 'http://channel.example.org/live.ts', headers: auth ? { 'Proxy-Authorization': authorization } : {} }, (res) => {
                res.resume(); res.on('end', () => resolve(res.statusCode));
            });
            req.on('error', reject); req.end();
        });
        assert.equal(await request('GET', false), 407);
        assert.equal(await request('POST', true), 403);
        assert.equal(await request('GET', true), 502);
        assert.equal(await request('GET', false), 407, 'still serving after upstream failure');
    } finally {
        http.ServerResponse.prototype.writeHead = original;
        if (proxy) proxy.close();
    }
});
