'use strict';

// PC screenshot helper only. The vendor software player ignores CLIP; the real
// renderer implements it. Emulate scissoring without modifying the shipped kit.
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const filename = require.resolve('../../native/javi-carlab/vendor/kit_record');
const original = fs.readFileSync(filename, 'utf8');
const pattern = /case OP\.CLIP: clip = \[f\[i\], f\[i \+ 1\], f\[i \+ 2\], f\[i \+ 3\]\]; i \+= 4; break;[^\r\n]*/;
if (!pattern.test(original)) throw new Error('Revisar el adaptador de recorte al actualizar kit_record');
const source = original.replace(pattern,
    'case OP.CLIP: clip = [f[i], f[i + 1], f[i + 2], f[i + 3]].map(Math.round); i += 4; cv = new Canvas(real.w, real.h); cv.d.set(real.d); break;')
    .replace('case OP.NOCLIP: clip = null; break;',
        'case OP.NOCLIP: if (clip) { const [x, y, w, h] = clip; for (let row = Math.max(0, y); row < Math.min(real.h, y+h); row++) { const start = (row * real.w + Math.max(0,x)) * 4; const end = (row * real.w + Math.min(real.w,x+w)) * 4; real.d.set(cv.d.subarray(start,end),start); } cv = real; clip = null; } break;');
const software = new Module(filename, module);
software.filename = filename;
software.paths = Module._nodeModulePaths(path.dirname(filename));
software._compile(source, filename);
require.cache[filename] = software;
module.exports = software.exports;
