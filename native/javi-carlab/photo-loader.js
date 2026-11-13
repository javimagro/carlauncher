'use strict';

const path = require('path');
const { URL } = require('url');
const { spawn } = require('child_process');
const { makeImage } = require('./vendor/kit_record.js');

// One active download/decode, at most eight pending requests. Obsolete focus
// requests are rejected before downloading and again before starting a decoder.
function createPhotoLoader() {
    const jobs = [];
    let active, child, closed = false;
    const cancelled = () => Object.assign(new Error('IMAGE_CANCELLED'), { code: 'IMAGE_CANCELLED' });

    function decode(bytes, w, h, contain) {
        return new Promise((resolve, reject) => {
            const worker = spawn(process.execPath, [path.join(__dirname, 'photo-worker.js'), String(w), String(h), contain ? '1' : '0'],
                { stdio: ['pipe', 'pipe', 'ignore'] });
            child = worker;
            const pixels = Buffer.alloc(w * h * 4);
            let count = 0, settled = false;
            const timer = setTimeout(() => finish(new Error('IMAGE_TIMEOUT')), 10000);
            function finish(error) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                child = null;
                if (error) { worker.kill('SIGKILL'); reject(error); }
                else resolve(makeImage(w, h, pixels));
            }
            worker.on('error', finish);
            worker.stdin.on('error', finish);
            worker.stdout.on('data', (chunk) => {
                if (count + chunk.length > pixels.length) { finish(new Error('IMAGE_SIZE')); return; }
                chunk.copy(pixels, count);
                count += chunk.length;
            });
            worker.on('close', (code) => finish(code || count !== pixels.length ? new Error('IMAGE_DECODE') : null));
            worker.stdin.end(bytes);
        });
    }

    function next() {
        if (active || closed) return;
        const job = jobs.shift();
        if (!job) return;
        if (!job.current()) { job.reject(cancelled()); next(); return; }
        active = job;
        Promise.resolve().then(() => job.get(job.url, 3 * 1024 * 1024)).then((bytes) => {
            if (closed || !job.current()) throw cancelled();
            return decode(bytes, job.w, job.h, job.contain);
        }).then(job.resolve, job.reject).then(() => { active = null; next(); });
    }
    return {
        load(url, get, w = 528, h = 297, contain = false, current = () => true) {
            if (closed) return Promise.reject(cancelled());
            let address;
            try { address = new URL(url); } catch (error) { return Promise.reject(error); }
            if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 1024 || h > 1024) return Promise.reject(new Error('IMAGE_SIZE'));
            if (address.hostname === 'imagenes.elpais.com' && address.pathname.startsWith('/resizer/v2/')) address.searchParams.set('width', '640');
            return new Promise((resolve, reject) => {
                if (jobs.length === 8) jobs.shift().reject(cancelled());
                jobs.push({ url: address.href, get, w, h, contain, current, resolve, reject });
                next();
            });
        },
        close() {
            closed = true;
            jobs.splice(0).forEach((job) => job.reject(cancelled()));
            if (child) child.kill('SIGKILL');
        }
    };
}

module.exports = { createPhotoLoader };
