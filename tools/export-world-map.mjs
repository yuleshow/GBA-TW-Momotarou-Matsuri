import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { decodePairs } from './font.mjs';

const rom = readFileSync('build/0023 - Momotarou Matsuri (J)(Rapid Fire).gba');
assert.equal(createHash('sha256').update(rom).digest('hex'),
  '938fa27a934ac3f4fa93d4d9e49bd538c2fb41040d0f7a8b2de6343a406f82d3');
function unpack(source, offset) {
  const kind = source[offset];
  const size = source.readUIntLE(offset + 1, 3);
  assert.ok(size > 0 && size <= 0x100000);
  if (kind === 0x90) return decodePairs(source, offset).data;
  if (kind === 0x80) {
    const wrapped = Buffer.from(source.subarray(offset));
    wrapped[0] = 0x90;
    wrapped.writeUIntLE(wrapped.readUInt32BE(4), 1, 3);
    const decoded = unpack(decodePairs(wrapped, 0).data, 0);
    assert.equal(decoded.length, size);
    return decoded;
  }
  if (kind === 0xf0) return source.subarray(offset + 4, offset + 4 + size);
  assert.equal(kind, 0xe0);
  assert.equal(size % 2, 0);
  const output = Buffer.alloc(size);
  const dictionary = new Uint16Array(1024);
  let writeIndex = 0x3be;
  let cursor = offset + 4;
  let written = 0;
  const emit = value => {
    assert.ok(written + 2 <= size);
    output.writeUInt16LE(value, written);
    written += 2;
    dictionary[writeIndex] = value;
    writeIndex = (writeIndex + 1) & 0x3ff;
  };
  while (written < size) {
    assert.ok(cursor < source.length);
    const flags = source[cursor++];
    for (let bit = 0; bit < 8 && written < size; bit++) {
      const token = source.readUInt16LE(cursor);
      cursor += 2;
      if (!(flags & (1 << bit))) {
        emit(token);
      } else {
        let readIndex = token >> 6;
        for (let count = 0; count < (token & 63) + 3; count++) {
          emit(dictionary[readIndex]);
          readIndex = (readIndex + 1) & 0x3ff;
        }
      }
    }
  }
  return output;
}

const record = 0x13f378;
const settlements = [];
const settlementNames = new Map([
  [5, '\u555f\u7a0b\u6751'], [6, '\u5580\u5693\u5580\u5693\u6751'],
  [7, '\u98ef\u7cf0\u6751'], [8, '\u7aae\u795e\u6751'],
  [9, '\u958b\u82b1\u6751'], [10, '\u91d1\u592a\u90ce\u6751'],
  [11, '\u6d66\u5cf6\u6751'], [12, '\u7761\u592a\u90ce\u6751'],
  [13, '\u5fae\u7b11\u6751'], [14, '\u5e0c\u671b\u90fd\u57ce'],
  [15, '\u5154\u9f9c\u6751'], [16, '\u7af9\u53d6\u6751'],
]);
const entrances = rom.readUInt32LE(record + 32) - 0x08000000;
let terminated = false;
for (let offset = entrances; offset < entrances + 0x2000; offset += 20) {
  const type = rom.readUInt16LE(offset + 8);
  if (type === 8) { terminated = true; break; }
  const script = rom.readUInt32LE(offset + 4);
  const mapId = rom.readUInt16LE(offset + 14);
  if (type !== 0 || script !== 0x08142470 || !settlementNames.has(mapId)) continue;
  const column = rom.readUInt16LE(offset + 10);
  const row = rom.readUInt16LE(offset + 12);
  assert.ok(column < 128 && row < 128);
  const existing = settlements.find(item => item.mapId === mapId);
  if (existing) {
    assert.ok(Math.abs(existing.column - column) <= 1 && existing.row === row);
    existing.entranceOffsets.push(offset);
  } else {
    settlements.push({ mapId, name: settlementNames.get(mapId), column, row,
      entranceOffsets: [offset], nameOffset: rom.readUInt32LE(0x140968 + mapId * 20) - 0x08000000 });
  }
}
assert.ok(terminated);
assert.equal(settlements.length, settlementNames.size);
if (process.argv.includes('--entrances')) {
  const start = rom.readUInt32LE(record + 32) - 0x08000000;
  for (let offset = start; offset < start + 0x2000; offset += 20) {
    const type = rom.readUInt16LE(offset + 8);
    if (type === 8) break;
    const script = rom.readUInt32LE(offset + 4) - 0x08000000;
    console.log(JSON.stringify({ offset: offset.toString(16), type,
      column: rom.readUInt16LE(offset + 10), row: rom.readUInt16LE(offset + 12),
      tail: rom.subarray(offset + 14, offset + 20).toString('hex'),
      script: script.toString(16), code: rom.subarray(script, script + 32).toString('hex') }));
  }
  process.exit(0);
}
const columns = rom.readUInt32LE(record);
const rows = rom.readUInt32LE(record + 4);
assert.equal(columns, 128);
assert.equal(rows, 128);
assert.equal(rom.readUInt32LE(record + 36), 0);
const resource = field => unpack(rom, rom.readUInt32LE(record + field) - 0x08000000);
const metatiles = resource(8);
const layout = resource(12);
const tiles = resource(16);
const palette = resource(20);
assert.equal(layout.length, columns * rows * 2);
assert.equal(metatiles.length % 10, 0);
assert.equal(tiles.length % 32, 0);
assert.equal(palette.length, 448);
const snapshot = readFileSync('build/encounter-state81.mgba');
const layoutMatch = 0x21000 + rom.readUInt32LE(0x322c) - 0x02000000;
let flagDifferences = 0;
const mismatches = [];
for (let index = 0; index < columns * rows; index++) {
  const original = layout.readUInt16LE(index * 2);
  const live = snapshot.readUInt16LE(layoutMatch + index * 2);
  if (original !== live) flagDifferences++;
  if ((original & 0xfff) !== (live & 0xfff)) mismatches.push({ index, original, live });
}
assert.equal(mismatches.length, 0, `World tile mismatches: ${JSON.stringify(mismatches.slice(0, 8))}`);
const width = columns * 16;
const height = rows * 16;
const pixels = Buffer.alloc(width * height * 3);
for (let mapRow = 0; mapRow < rows; mapRow++) {
  for (let mapColumn = 0; mapColumn < columns; mapColumn++) {
    const meta = layout.readUInt16LE((mapRow * columns + mapColumn) * 2) & 0xfff;
    assert.ok(meta * 10 + 10 <= metatiles.length);
    for (let quadrant = 0; quadrant < 4; quadrant++) {
      const entry = metatiles.readUInt16LE(meta * 10 + quadrant * 2);
      const tile = entry & 0x3ff;
      assert.ok(tile * 32 + 32 <= tiles.length);
      for (let pixelRow = 0; pixelRow < 8; pixelRow++) {
        for (let pixelColumn = 0; pixelColumn < 8; pixelColumn++) {
          const sourceRow = entry & 0x800 ? 7 - pixelRow : pixelRow;
          const sourceColumn = entry & 0x400 ? 7 - pixelColumn : pixelColumn;
          const packed = tiles[tile * 32 + sourceRow * 4 + (sourceColumn >> 1)];
          const ink = (packed >> ((sourceColumn & 1) * 4)) & 15;
          const color = palette.readUInt16LE((ink ? (entry >> 12) * 16 + ink : 0) * 2);
          const column = mapColumn * 16 + (quadrant % 2) * 8 + pixelColumn;
          const row = mapRow * 16 + (quadrant >> 1) * 8 + pixelRow;
          const destination = (row * width + column) * 3;
          for (let channel = 0; channel < 3; channel++) {
            const value = (color >> (channel * 5)) & 31;
            pixels[destination + channel] = (value << 3) | (value >> 2);
          }
        }
      }
    }
  }
}
const prefix = 'build/world-map';
writeFileSync(`${prefix}.ppm`, Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]));
execFileSync('sips', ['-s', 'format', 'png', `${prefix}.ppm`, '--out', `${prefix}.png`]);
writeFileSync(`${prefix}.json`, JSON.stringify({ width, height, columns, rows,
  metatiles: metatiles.length / 10, tiles: tiles.length / 32,
  snapshotLayoutMatch: layoutMatch, flagDifferences, paletteBytes: palette.length,
  settlements,
  limitations: ['Static overworld terrain only; no NPCs, player marker, interior maps or story-dependent objects.'],
}, null, 2));
console.log(`${prefix}.png: ${width}x${height}, full layout matches handheld snapshot at ${layoutMatch.toString(16)}`);
execFileSync('swiftc', ['tools/label-world-map.swift', '-o', 'build/label-world-map']);
console.log(execFileSync('build/label-world-map', [], { encoding: 'utf8' }));