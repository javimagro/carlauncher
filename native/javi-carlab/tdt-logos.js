'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { URL } = require('url');
const { makeImage, dropImage } = require('./vendor/kit_record');

const key = (value) => String(value || '').normalize('NFD').toLowerCase().replace(/[^a-z0-9]/g, '');
const nameKey = (value) => key(String(value || '').replace(/\(\d+p\)|\[[^\]]+\]/ig, ''));

function resolve(index, country, channel) {
    const region = index.regions[country] || {};
    const epg = String(channel.epg || '');
    const name = nameKey(channel.name);
    let fingerprint;
    if (channel.logo) {
        try {
            const url = new URL(channel.logo);
            fingerprint = crypto.createHash('sha256').update(url.hostname + decodeURIComponent(url.pathname)).digest('hex');
        } catch (_) { /* Malformed catalogue logos still have channel aliases. */ }
    }
    const candidates = [region[key(epg)], index.urls[fingerprint], region[key(channel.name)], region[name],
        region[key(epg.split('@')[0])], index.local[name], index.local[key(channel.id)]];
    const branded = candidates.find((id) => Number.isInteger(id) && id !== index.generic);
    return branded === undefined ? candidates.find(Number.isInteger) : branded;
}

function createLogos(change, directory = __dirname) {
    const images = new Map();
    const pack = path.join(directory, 'tdt-logos.pack');
    let index, started = false, pending = false, closed = false, wanted = new Set(), aliases = new WeakMap();

    function lookup(country, channel) {
        if (!index || !channel) return undefined;
        let entry = aliases.get(channel);
        if (!entry || entry.country !== country) {
            const id = resolve(index, country, channel);
            entry = { country, id: id >= 0 && id < index.offsets.length ? id : undefined };
            aliases.set(channel, entry);
        }
        return entry.id;
    }

    function read(id) {
        const row = index.offsets[id], size = index.size, pixels = size * size * 4;
        function finish(image) {
            pending = false;
            if (closed || !wanted.has(id)) return;
            images.set(id, image && makeImage(size, size, image));
            if (images.size > 24) {
                const oldest = Array.from(images.keys()).find((key) => !wanted.has(key));
                const oldImage = images.get(oldest);
                if (oldImage) dropImage(oldImage);
                images.delete(oldest);
            }
            if (image) change();
        }
        if (!Array.isArray(row) || !Number.isSafeInteger(row[0]) || row[0] < 0 || row[0] >= 64 * 1024 * 1024 ||
            !Number.isInteger(row[1]) || row[1] <= 0 || row[1] > pixels + 1024) { finish(); return; }
        pending = true;
        fs.open(pack, 'r', (openError, descriptor) => {
            if (openError) return finish();
            if (closed || !wanted.has(id)) { fs.close(descriptor, () => {}); return finish(); }
            const bytes = Buffer.alloc(row[1]);
            fs.read(descriptor, bytes, 0, bytes.length, row[0], (error, length) => {
                fs.close(descriptor, () => {});
                if (error || length !== bytes.length || closed || !wanted.has(id)) return finish();
                const inflater = zlib.createInflate(), rgba = Buffer.alloc(pixels);
                let copied = 0;
                inflater.on('data', (chunk) => {
                    if (copied + chunk.length > pixels) { inflater.destroy(new Error('TDT_LOGO_SIZE')); return; }
                    chunk.copy(rgba, copied);
                    copied += chunk.length;
                });
                inflater.once('error', () => finish());
                inflater.once('end', () => finish(copied === pixels ? rgba : undefined));
                inflater.end(bytes);
            });
        });
    }

    return {
        image(country, channel) { return images.get(lookup(country, channel)); },
        load(country, channels) {
            if (closed) return;
            if (!started && channels.length) {
                started = true;
                fs.readFile(path.join(directory, 'tdt-logos.json'), (error, bytes) => {
                    if (closed || error || bytes.length > 512 * 1024) return;
                    try {
                        const data = JSON.parse(bytes);
                        if (data.size === 90 && Array.isArray(data.offsets) && data.offsets.length <= 5000 && data.urls && data.regions && data.local) index = data;
                    } catch (_) { /* Keep channel initials if the logo index is unavailable. */ }
                    if (index) change();
                });
            }
            wanted = new Set(channels.map((channel) => lookup(country, channel)).filter(Number.isInteger));
            if (!pending) {
                const next = Array.from(wanted).find((id) => !images.has(id));
                if (next !== undefined) read(next);
            }
        },
        close() {
            closed = true;
            wanted.clear();
            images.forEach((image) => { if (image) dropImage(image); });
            images.clear();
            index = undefined;
            aliases = new WeakMap();
        }
    };
}

module.exports = { createLogos, resolve };
