'use strict';

const dns = require('dns');
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

function lookupForUplink() {
    const lease = JSON.parse(fs.readFileSync('/run/mgu-uplink/lease.json', 'utf8'));
    if (!Array.isArray(lease.dns) || !lease.dns.length) throw new Error('No hay DNS de mgu-uplink');
    const resolver = new dns.Resolver();
    resolver.setServers(lease.dns);
    return (host, options, done) => {
        resolver.resolve4(host, (error, addresses) => {
            if (error) return done(error);
            const address = addresses.find((value) => {
                const [a, b] = value.split('.').map(Number);
                return a > 0 && a < 224 && a !== 10 && a !== 127
                    && !(a === 100 && b >= 64 && b <= 127) && !(a === 169 && b === 254)
                    && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168);
            });
            if (!address) return done(new Error('No hay una dirección pública'));
            return done(null, address, 4);
        });
    };
}

function download(url, limit, lookup, redirects = 3) {
    return new Promise((resolve, reject) => {
        const address = new URL(url);
        if (address.protocol !== 'https:' || address.username || address.password || address.port
            || !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(address.hostname)) {
            reject(new Error('Se requiere un dominio HTTPS'));
            return;
        }
        const request = https.get({
            hostname: address.hostname, path: address.pathname + address.search, lookup,
            headers: { 'User-Agent': 'BMWLauncher/0.2', 'Accept-Encoding': 'identity' }
        }, (res) => {
            if (redirects && [301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                try { resolve(download(new URL(res.headers.location, address).href, limit, lookup, redirects - 1)); }
                catch (error) { reject(error); }
                return;
            }
            if (res.statusCode !== 200) {
                res.resume();
                reject(new Error('HTTP ' + res.statusCode));
                return;
            }
            const chunks = [];
            let size = 0;
            res.on('error', reject);
            res.on('aborted', () => reject(new Error('Respuesta interrumpida')));
            res.on('data', (chunk) => {
                size += chunk.length;
                if (size > limit) res.destroy(new Error('Respuesta demasiado grande'));
                else chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        const deadline = setTimeout(() => request.destroy(new Error('Tiempo de espera agotado')), 8500);
        request.on('close', () => clearTimeout(deadline));
        request.on('error', reject);
    });
}

if (require.main === module) {
    const [url, limit] = process.argv.slice(2);
    Promise.resolve().then(() => download(url, Number(limit), lookupForUplink()))
        .then((bytes) => process.stdout.write(bytes))
        .catch(() => { process.exitCode = 1; });
}

module.exports = download;
