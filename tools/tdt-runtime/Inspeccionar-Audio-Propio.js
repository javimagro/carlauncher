'use strict';

// Manual, read-only MGU21 diagnostic. Never installed or run by BMWLauncher.
// Private firmware offsets are gated by the exact executable SHA-256.
const fs = require('fs');
const crypto = require('crypto');
const HASH = 'a95e789dc5efeb8007faa30ff3e932185bfdfd8f745a21815bdba26c2b3cf722';
const VTABLE = 0x187c0b8;
const TOKEN = '/tmp/bmwlauncher-audio-probe/own-focus-token';
const MAX_SCAN = 64 * 1024 * 1024;

function pointer(buffer, offset) {
  const n = buffer.readUInt32LE(offset) + buffer.readUInt32LE(offset + 4) * 0x100000000;
  if (!Number.isSafeInteger(n) || n < 0 || n > 0x7fffffffffff) throw new Error('Invalid pointer');
  return n;
}

function decodeToken(buffer) {
  if (buffer.length < 10 || buffer.length > 520 || buffer.readUInt32BE(0) !== buffer.length - 4 ||
      buffer[4] !== 254 || buffer[5] !== 255 || buffer.length % 2 ||
      buffer.readUInt16BE(buffer.length - 2) !== 0) throw new Error('Invalid own token');
  const little = Buffer.from(buffer.slice(6, -2));
  little.swap16();
  const value = little.toString('utf16le');
  if (!value || value.indexOf('\0') !== -1) throw new Error('Invalid own token');
  return Buffer.from(value, 'utf8');
}

function parseMaps(text) {
  return text.split('\n').map(function (line) {
    const m = /^([0-9a-f]+)-([0-9a-f]+)\s+([rwxps-]{4})\s+([0-9a-f]+)\s+\S+\s+\d+\s*(.*)$/i.exec(line);
    if (!m) return null;
    const start = parseInt(m[1], 16), end = parseInt(m[2], 16), offset = parseInt(m[4], 16);
    if (!Number.isSafeInteger(end) || start >= end || end > 0x7fffffffffff) return null;
    return { start: start, end: end, permissions: m[3], offset: offset, name: m[5] };
  }).filter(Boolean);
}

function vectorCount(begin, end, capacity, stride) {
  if (begin === 0 && end === 0 && capacity === 0) return 0;
  if (!begin || end < begin || capacity < end || (end - begin) % stride ||
      (capacity - begin) % stride || capacity - begin > 255 * stride) throw new Error('Unstable vector');
  return (end - begin) / stride;
}

// Output is deliberately limited to counters/flags of our token-matched device.
// No raw memory, addresses, URI, metadata, token or other source is returned.
function snapshot(read, address, expectedVtable, token) {
  const object = read(address, 0x2a0);
  if (pointer(object, 0) !== expectedVtable) return null;
  const length = pointer(object, 0x290);
  if (length !== token.length) return null;
  if (!read(pointer(object, 0x288), length).equals(token)) return null;
  const streams = vectorCount(pointer(object, 0x110), pointer(object, 0x118), pointer(object, 0x120), 0x48);
  const playlist = read(pointer(object, 0xb0), 8).readInt32LE(4);
  if (playlist < 0 || playlist > 255 || playlist !== streams) throw new Error('Unstable playlist');
  const activity = read(pointer(object, 0x18) + 0x110, 13);
  if (activity[0] > 1 || activity[12] > 1 || object[0x240] > 1 || object[0x284] > 1) {
    throw new Error('Invalid flags');
  }
  const selected = object.readUInt32LE(0x228);
  if (selected > streams) throw new Error('Unstable selection');
  // Read again to reject changes during the non-atomic snapshot.
  if (!read(address, object.length).equals(object) ||
      !read(pointer(object, 0x288), length).equals(token) ||
      !read(pointer(object, 0x18) + 0x110, 13).equals(activity) ||
      read(pointer(object, 0xb0), 8).readInt32LE(4) !== playlist) throw new Error('Snapshot changed');
  return { ownDevice: true, playlistItems: playlist, streamItems: streams,
    selectedPosition: selected, requestedTimeMs: object.readUInt32LE(0x22c),
    sourceActivityOn: !!activity[0], pendingActivityCode: activity.readInt32LE(8),
    activityFlag11c: !!activity[12], playingFile: !!object[0x240],
    createPlaylistRequestPending: !!object[0x284], atomic: false, audible: 'not_measured' };
}

function scan(read, ranges, vtable, token, clock) {
  const started = clock(), candidates = [], needle = Buffer.alloc(8);
  needle.writeUInt32LE(vtable % 0x100000000, 0);
  needle.writeUInt32LE(Math.floor(vtable / 0x100000000), 4);
  let bytes = 0, failures = 0, matches = 0, limited = false;
  const heaps = ranges.filter(function (r) {
    return r.permissions === 'rw-p' && (r.name === '[heap]' || r.name === '');
  });
  outer: for (let r = 0; r < heaps.length; r++) {
    for (let at = heaps[r].start; at < heaps[r].end; at += 65536) {
      if (bytes >= MAX_SCAN || clock() - started >= 3000 || matches >= 128) { limited = true; break outer; }
      const size = Math.min(65536, heaps[r].end - at, MAX_SCAN - bytes);
      bytes += size;
      let chunk;
      try { chunk = read(at, size); } catch (_) { failures++; continue; }
      for (let offset = chunk.indexOf(needle); offset !== -1; offset = chunk.indexOf(needle, offset + 1)) {
        if ((at + offset) % 8) continue;
        matches++;
        if (matches > 128 || clock() - started >= 3000) { limited = true; break outer; }
        try {
          const value = snapshot(read, at + offset, vtable, token);
          if (value) candidates.push(value);
        } catch (_) { failures++; }
      }
    }
  }
  const result = { status: candidates.length > 1 ? 'ambiguous' : 'inconclusive', scannedBytes: bytes,
    limited: limited, readFailures: failures, ownMatches: candidates.length };
  if (candidates.length === 1 && !limited && failures === 0) {
    result.status = 'observed'; result.device = candidates[0];
  } else if (candidates.length === 1) {
    // A bounded/partial search cannot establish uniqueness; retain only this fact.
    result.status = 'partial_match';
  }
  return result;
}

function ownToken() {
  const directory = fs.lstatSync('/tmp/bmwlauncher-audio-probe');
  if (!directory.isDirectory() || directory.uid !== process.geteuid() || (directory.mode & 511) !== 493) {
    throw new Error('Private trial directory required');
  }
  const fd = fs.openSync(TOKEN, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid() || (stat.mode & 511) !== 384 || stat.size > 520) {
      throw new Error('Private own token required');
    }
    return decodeToken(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}

function hashExecutable(file) {
  return new Promise(function (resolve, reject) {
    const hash = crypto.createHash('sha256'), input = fs.createReadStream(file);
    let size = 0, finished = false;
    const timer = setTimeout(function () { finish(new Error('Executable hash timeout')); }, 8000);
    function finish(error, value) {
      if (finished) return; finished = true; clearTimeout(timer); input.destroy();
      if (error) reject(error); else resolve(value);
    }
    input.on('data', function (chunk) {
      size += chunk.length;
      if (size > 128 * 1024 * 1024) return finish(new Error('Executable too large'));
      hash.update(chunk);
    });
    input.on('error', function () { finish(new Error('Executable unreadable')); });
    input.on('end', function () { finish(null, hash.digest('hex')); });
  });
}

function birth(pid) {
  const text = fs.readFileSync('/proc/' + pid + '/stat', 'utf8');
  return text.slice(text.lastIndexOf(')') + 2).split(' ')[19];
}

async function main(args) {
  if (process.platform !== 'linux' || process.env.BMWLAUNCHER_AUDIO_TRIAL !== '1') {
    throw new Error('Manual MGU inspection only; BMWLAUNCHER_AUDIO_TRIAL=1 requires an authorised trial');
  }
  if (args.length !== 2 || args[0] !== '--inspect-own' || !/^[1-9][0-9]{0,8}$/.test(args[1])) {
    throw new Error('Usage: node Inspeccionar-Audio-Propio.js --inspect-own MEDIAAPP_PID');
  }
  const pid = args[1], token = ownToken(), originalBirth = birth(pid), proc = '/proc/' + pid;
  if (fs.readlinkSync(proc + '/exe') !== '/usr/bin/mediaapp' || await hashExecutable(proc + '/exe') !== HASH) {
    throw new Error('Unsupported mediaapp firmware');
  }
  const maps = parseMaps(fs.readFileSync(proc + '/maps', 'utf8'));
  const image = maps.filter(function (r) { return r.offset === 0 && r.name === '/usr/bin/mediaapp'; });
  if (image.length !== 1) throw new Error('Ambiguous mediaapp mapping');
  const fd = fs.openSync(proc + '/mem', 'r');
  let result;
  try {
    function read(address, size) {
      if (!Number.isSafeInteger(address) || address <= 0 || size <= 0 || size > 65536 ||
          !maps.some(function (r) { return r.permissions[0] === 'r' && address >= r.start && address + size <= r.end; })) {
        throw new Error('Unmapped range');
      }
      const buffer = Buffer.alloc(size);
      if (fs.readSync(fd, buffer, 0, size, address) !== size) throw new Error('Short read');
      return buffer;
    }
    const start = process.hrtime();
    result = scan(read, maps, image[0].start + VTABLE, token, function () {
      const elapsed = process.hrtime(start); return elapsed[0] * 1000 + elapsed[1] / 1e6;
    });
  } finally { fs.closeSync(fd); }
  if (birth(pid) !== originalBirth || !ownToken().equals(token)) throw new Error('Process or own trial changed');
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'observed') process.exitCode = 2;
}

if (require.main === module) main(process.argv.slice(2)).catch(function () {
  // Avoid disclosing paths, memory contents or focus token through exception text.
  process.stderr.write('Audio inspection unavailable; no state changed. Check trial, firmware and permissions.\n');
  process.exitCode = 1;
});
module.exports = { decodeToken: decodeToken, parseMaps: parseMaps, snapshot: snapshot, scan: scan };
