'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const inspector = require('../../tools/tdt-runtime/Inspeccionar-Audio-Propio');

function fixture() {
  const memory = Buffer.alloc(0x3000), address = 0x1000, vtable = 0x187c0b8;
  const token = Buffer.from('local-test-token');
  function ptr(at, value) { memory.writeUInt32LE(value, at); }
  ptr(address, vtable); ptr(address + 0x288, 0x1800); ptr(address + 0x290, token.length);
  token.copy(memory, 0x1800);
  ptr(address + 0xb0, 0x1900); memory.writeInt32LE(1, 0x1904);
  ptr(address + 0x110, 0x2000); ptr(address + 0x118, 0x2048); ptr(address + 0x120, 0x2048);
  ptr(address + 0x18, 0x2100); memory[0x2210] = 1;
  memory.writeUInt32LE(1, address + 0x228); memory[address + 0x284] = 1;
  function read(at, size) {
    if (at <= 0 || at + size > memory.length) throw new Error('unmapped');
    return Buffer.from(memory.slice(at, at + size));
  }
  return { memory, address, vtable, token, read, ptr };
}

test('audio: muestra únicamente estado de la fuente cuyo token pertenece a la prueba', () => {
  const f = fixture(), value = inspector.snapshot(f.read, f.address, f.vtable, f.token);
  assert.equal(value.playlistItems, 1);
  assert.equal(value.streamItems, 1);
  assert.equal(value.selectedPosition, 1);
  assert.equal(value.sourceActivityOn, true);
  assert.equal(value.createPlaylistRequestPending, true);
  assert.equal(value.audible, 'not_measured');
  assert.equal(value.atomic, false);
  assert.equal(JSON.stringify(value).includes(f.token.toString()), false);
  assert.equal(inspector.snapshot(f.read, f.address, f.vtable + 8, f.token), null);
  assert.equal(inspector.snapshot(f.read, f.address, f.vtable, Buffer.from('other-test-token')), null);
});

test('audio: diferencia lista vacía y fuente inactiva sin inventar un fallo del altavoz', () => {
  const f = fixture();
  f.memory.writeInt32LE(0, 0x1904);
  f.memory.fill(0, f.address + 0x110, f.address + 0x128);
  f.memory.writeUInt32LE(0, f.address + 0x228); f.memory[0x2210] = 0;
  const value = inspector.snapshot(f.read, f.address, f.vtable, f.token);
  assert.equal(value.playlistItems, 0);
  assert.equal(value.selectedPosition, 0);
  assert.equal(value.sourceActivityOn, false);
});

test('audio: rechaza punteros, vectores, contadores y lecturas cambiantes', () => {
  const f = fixture();
  f.ptr(f.address + 0x118, 0x2049);
  assert.throws(() => inspector.snapshot(f.read, f.address, f.vtable, f.token), /vector/);
  f.ptr(f.address + 0x118, 0x2048); f.memory.writeInt32LE(2, 0x1904);
  assert.throws(() => inspector.snapshot(f.read, f.address, f.vtable, f.token), /playlist/);
  f.memory.writeInt32LE(1, 0x1904);
  let reads = 0;
  assert.throws(() => inspector.snapshot((at, size) => {
    if (at === f.address && ++reads === 2) f.memory[f.address + 0x240] = 1;
    return f.read(at, size);
  }, f.address, f.vtable, f.token), /changed/);
  f.ptr(f.address + 0x18, 0xffff);
  assert.throws(() => inspector.snapshot(f.read, f.address, f.vtable, f.token), /unmapped/);
});

test('audio: búsqueda acotada ignora regiones ajenas y no elige entre dos coincidencias', () => {
  const f = fixture(), ranges = [{start: 0x1000, end: 0x3000, permissions: 'rw-p', name: '[heap]'}];
  assert.equal(inspector.scan(f.read, ranges, f.vtable, f.token, () => 0).status, 'observed');
  const ignored = Object.assign({}, ranges[0], {name: '/usr/lib/other.so'});
  assert.equal(inspector.scan(() => { throw new Error('must not read'); }, [ignored], f.vtable, f.token, () => 0).scannedBytes, 0);
  f.memory.copy(f.memory, 0x1400, f.address, f.address + 0x2a0);
  const multiple = inspector.scan(f.read, ranges, f.vtable, f.token, () => 0);
  assert.equal(multiple.status, 'ambiguous'); assert.equal(multiple.device, undefined);
  let now = 0;
  const bounded = inspector.scan(f.read, ranges, f.vtable, f.token, () => { now += 4000; return now; });
  assert.equal(bounded.limited, true); assert.equal(bounded.scannedBytes, 0);
});

test('audio: token y mapas malformados no habilitan lecturas', () => {
  const utf = Buffer.from('local-token\0', 'utf16le'); utf.swap16();
  const wire = Buffer.alloc(6 + utf.length); wire.writeUInt32BE(2 + utf.length, 0);
  wire[4] = 254; wire[5] = 255; utf.copy(wire, 6);
  assert.equal(inspector.decodeToken(wire).toString(), 'local-token');
  assert.throws(() => inspector.decodeToken(wire.slice(0, -1)), /token/);
  wire[5] = 0; assert.throws(() => inspector.decodeToken(wire), /token/);
  assert.deepEqual(inspector.parseMaps('broken\nffffffffffffffff-ffffffffffffffff rw-p 0 00:00 0'), []);
  assert.deepEqual(inspector.parseMaps('1000-3000 rw-p 00000000 00:00 0 [heap]'),
    [{start: 0x1000, end: 0x3000, permissions: 'rw-p', offset: 0, name: '[heap]'}]);
});
