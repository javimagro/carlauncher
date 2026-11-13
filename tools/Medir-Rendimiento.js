'use strict';

// Run with the car's Node version on the same machine before/after a change.
// The optional JPEG is local; its contents and path are never written to reports.
const fs = require('fs');
const elapsed = (start) => { const t = process.hrtime(start); return t[0] * 1000 + t[1] / 1e6; };
const start = process.hrtime();
const { createData, loadArtwork, loadPhoto } = require('../native/javi-carlab/drivehub-data');
const { Recorder, dropImage } = require('../native/javi-carlab/vendor/kit_record');
const { drawHome } = require('../native/javi-carlab/drivehub-view');
const { createPhotoLoader } = require('../native/javi-carlab/photo-loader');
const result = { node: process.version, platform: process.platform, modulesMs: elapsed(start) };
const artStart = process.hrtime(), art = loadArtwork();
result.artMs = elapsed(artStart);
const cv = new Recorder(1960, 520);
const data = Object.assign(createData({ fixture: {} }, () => {}).data, { diagnostics: true, altitudeHistory: { values: [] } });
const frames = [];
for (let i = 0; i < 100; i++) {
    const at = process.hrtime();
    cv.reset(); drawHome(cv, { selected: 0 }, 0, data, art, Date.now());
    frames.push(elapsed(at));
}
frames.sort((a, b) => a - b);
result.drawMs = { median: frames[50], p95: frames[95], max: frames[99] };

async function photos(bytes, isolated) {
    const loader = createPhotoLoader();
    let gap = 0, previous = process.hrtime();
    const timer = setInterval(() => { gap = Math.max(gap, elapsed(previous)); previous = process.hrtime(); }, 10);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const at = process.hrtime();
    try {
        const image = await (isolated ? loader.load : loadPhoto)('https://example.org/local-fixture.jpg', async () => bytes);
        const total = elapsed(at);
        dropImage(image);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { totalMs: total, maxTimerGapMs: gap };
    } finally { clearInterval(timer); loader.close(); }
}

(async () => {
    if (process.argv[2]) {
        const bytes = fs.readFileSync(process.argv[2]);
        result.image = { bytes: bytes.length, inline: await photos(bytes, false), isolated: await photos(bytes, true) };
    }
    result.memory = process.memoryUsage();
    console.log(JSON.stringify(result, null, 2));
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
