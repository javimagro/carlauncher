'use strict';

// Runs only in a disposable child: JPEG decoding and resizing are CPU work.
const decodeJpeg = require('./vendor/jpeg-decoder.js');
const png = require('./vendor/kit_png.js');

async function resize(bytes, w, h, contain) {
    let image;
    if (bytes.toString('hex', 0, 8) === '89504e470d0a1a0a') {
        // Check dimensions before inflating an untrusted PNG.
        if (bytes.length < 24 || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) ||
            bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 10000000) throw new Error('IMAGE_SIZE');
        image = await new Promise((resolve, reject) => png.decodeAsync(bytes, (err, value) => err ? reject(err) : resolve(value)));
    } else {
        const jpg = decodeJpeg(bytes, { maxResolutionInMP: 10, maxMemoryUsageInMB: 48 });
        image = { w: jpg.width, h: jpg.height, data: jpg.data };
    }
    const scale = contain ? Math.min(w / image.w, h / image.h) : Math.max(w / image.w, h / image.h);
    const left = (image.w - w / scale) / 2, top = (image.h - h / scale) / 2;
    const rgba = Buffer.isBuffer(image.data) ? image.data : Buffer.from(image.data);
    const pixels = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            const sx = Math.floor(left + (x + 0.5) / scale), sy = Math.floor(top + (y + 0.5) / scale);
            if (sx < 0 || sy < 0 || sx >= image.w || sy >= image.h) continue;
            rgba.copy(pixels, (y * w + x) * 4, (sy * image.w + sx) * 4, (sy * image.w + sx) * 4 + 4);
        }
    }
    return pixels;
}

if (require.main === module) {
    const w = Number(process.argv[2]), h = Number(process.argv[3]);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1 || w > 1024 || h > 1024) process.exit(2);
    const chunks = [];
    let size = 0;
    process.stdin.on('data', (chunk) => {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) process.exit(2);
        chunks.push(chunk);
    });
    process.stdin.on('end', () => resize(Buffer.concat(chunks), w, h, process.argv[4] === '1')
        .then((pixels) => process.stdout.write(pixels), () => { process.exitCode = 3; }));
}

module.exports = resize;
