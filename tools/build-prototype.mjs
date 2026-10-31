import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { characterMap, decodeText } from './extract-text.mjs';
import { decodePairs, encodeLiteralPairs, tileSheet, validateGlyphTiles } from './font.mjs';
import { inspectRom, readRom } from './inspect-rom.mjs';

export const translationFont = {
  name: 'Fusion Pixel 8px Traditional Chinese',
  path: 'assets/fonts/fusion-pixel-2026.09.01/fusion-pixel-8px-monospaced-zh_hant.ttf',
  sha256: '94456bf00a477df7c9cd6dedac5f6d53dce3faf6e5ddde60ab25099e82b2f1fb',
  pointSize: 8,
  license: 'SIL-OFL-1.1',
  licensePath: 'assets/fonts/fusion-pixel-2026.09.01/OFL.txt',
  source: 'https://github.com/TakWolf/fusion-pixel-font',
};

export function makeIps(source, target) {
  assert.ok(target.length >= source.length && target.length <= 0xffffff,
    'IPS supports expansion only, up to 0xffffff bytes');
  const records = [Buffer.from('PATCH')];
  for (let offset = 0; offset < target.length;) {
    if (offset < source.length && source[offset] === target[offset]) {
      offset++;
      continue;
    }
    const start = offset === 0x454f46 ? offset - 1 : offset;
    while (offset < target.length && (offset >= source.length || source[offset] !== target[offset]) &&
      offset - start < 65535) offset++;
    const header = Buffer.alloc(5);
    header.writeUIntBE(start, 0, 3);
    header.writeUInt16BE(offset - start, 3);
    records.push(header, target.subarray(start, offset));
  }
  records.push(Buffer.from('EOF'));
  if (target.length !== source.length) {
    const length = Buffer.alloc(3);
    length.writeUIntBE(target.length, 0, 3);
    records.push(length);
  }
  return Buffer.concat(records);
}

export function applyPrototypeIps(source, patch) {
  assert.equal(patch.subarray(0, 5).toString(), 'PATCH');
  assert.ok(source.length <= 0xffffff, 'ROM exceeds IPS address space');
  const records = [];
  let targetLength = source.length;
  let offset = 5;
  while (offset + 3 <= patch.length) {
    const address = patch.readUIntBE(offset, 3);
    offset += 3;
    if (address === 0x454f46) {
      assert.ok(patch.length - offset === 0 || patch.length - offset === 3, 'Invalid IPS trailer');
      if (patch.length - offset === 3) {
        const declaredLength = patch.readUIntBE(offset, 3);
        assert.ok(declaredLength >= targetLength, 'IPS target length truncates source or records');
        targetLength = declaredLength;
      }
      const output = Buffer.alloc(targetLength, 0xff);
      source.copy(output);
      for (const record of records) {
        if (record.value !== undefined) output.fill(record.value, record.address, record.address + record.size);
        else patch.copy(output, record.address, record.offset, record.offset + record.size);
      }
      return output;
    }
    assert.ok(offset + 2 <= patch.length, 'Truncated IPS record');
    const size = patch.readUInt16BE(offset);
    offset += 2;
    if (size === 0) {
      assert.ok(offset + 3 <= patch.length, 'Truncated IPS RLE record');
      const runSize = patch.readUInt16BE(offset);
      assert.ok(runSize > 0, 'Empty IPS RLE record');
      records.push({ address, size: runSize, value: patch[offset + 2] });
      targetLength = Math.max(targetLength, address + runSize);
      offset += 3;
    } else {
      assert.ok(offset + size <= patch.length, 'Truncated IPS record data');
      records.push({ address, size, offset });
      targetLength = Math.max(targetLength, address + size);
      offset += size;
    }
    assert.ok(targetLength <= 0xffffff, 'IPS record exceeds address space');
  }
  throw new Error('Missing IPS end marker');
}

export function buildPrototype(source, catalog, characters, tiles) {
  const info = inspectRom(source);
  assert.equal(catalog.sourceSha256, info.sha256);
  assert.equal(catalog.language, 'zh-Hant');
  assert.ok(characters.length > 0 && characters.length <= 64, 'Prototype glyph bank supports at most 64 characters');
  assert.equal(new Set(characters).size, characters.length);
  assert.equal(tiles.length, characters.length * 32);
  const glyphCodes = new Map(characters.map((character, index) => [character, 0x40 + index]));
  const output = Buffer.from(source);
  const originalFont = decodePairs(source, 0x2f8ecc).data;
  assert.equal(originalFont.length, 0x2000);
  const expandedFont = Buffer.alloc(0x3000, 0x11);
  originalFont.copy(expandedFont);
  tiles.copy(expandedFont, 0x140 * 32);
  let cursor = (info.trailingPadding.offset + 3) & ~3;
  const allocations = [];
  const allocate = (data, label) => {
    cursor = (cursor + 3) & ~3;
    assert.ok(cursor + data.length <= output.length, 'Insufficient trailing padding');
    assert.ok(source.subarray(cursor, cursor + data.length).every(byte => byte === 0xff));
    const address = cursor;
    data.copy(output, cursor);
    cursor += data.length;
    allocations.push({ label, offset: address, size: data.length });
    return address;
  };
  const fontOffset = allocate(encodeLiteralPairs(expandedFont), 'expanded-font');
  assert.equal(source.readUInt32LE(0x46a7c), 0x082f8ecc);
  output.writeUInt32LE(fontOffset + 0x08000000, 0x46a7c);
  const sourceCharacters = characterMap(source);
  const translated = [];
  for (const entry of catalog.entries) {
    const offset = Number.parseInt(entry.offset, 16);
    assert.ok(Number.isInteger(offset) && offset >= 0x163800 && offset < 0x164100);
    const end = source.indexOf(0, offset);
    assert.ok(end > offset && end - offset < 100);
    assert.equal(decodeText(source.subarray(offset, end), sourceCharacters), entry.source);
    const bytes = [];
    for (const character of entry.translation) {
      const code = glyphCodes.get(character);
      assert.notEqual(code, undefined, `Missing character: ${character}`);
      bytes.push(5, code);
    }
    bytes.push(0);
    const pointerOffsets = [];
    for (let position = 0; position + 4 <= source.length; position += 4) {
      if (source.readUInt32LE(position) === offset + 0x08000000) pointerOffsets.push(position);
    }
    assert.ok(pointerOffsets.length > 0, `No pointers to ${entry.offset}`);
    const target = allocate(Buffer.from(bytes), entry.offset);
    for (const pointer of pointerOffsets) output.writeUInt32LE(target + 0x08000000, pointer);
    translated.push({ ...entry, targetOffset: target, pointerOffsets });
  }
  assert.deepEqual(decodePairs(output, fontOffset).data, expandedFont);
  assert.deepEqual(output.subarray(0, 0xc0), source.subarray(0, 0xc0));
  const patch = makeIps(source, output);
  assert.deepEqual(applyPrototypeIps(source, patch), output);
  return {
    rom: output,
    patch,
    manifest: {
      status: 'experimental-menu-prototype-not-full-translation',
      sourceSha256: info.sha256,
      outputSha256: createHash('sha256').update(output).digest('hex'),
      glyphCount: characters.length,
      glyphSize: '8x8-experimental',
      fontOffset,
      allocations,
      translated,
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = readRom(process.argv[2]);
  inspectRom(source);
  const catalog = JSON.parse(readFileSync(new URL('../translations/menus.zh-Hant.json', import.meta.url)));
  const characters = [...new Set(catalog.entries.flatMap(entry => [...entry.translation]))];
  const fontPath = translationFont.path;
  const fontSha256 = createHash('sha256').update(readFileSync(fontPath)).digest('hex');
  assert.equal(fontSha256, translationFont.sha256);
  mkdirSync('build', { recursive: true });
  writeFileSync('build/characters.json', JSON.stringify(characters));
  execFileSync('swiftc', ['tools/rasterize-font.swift', '-o', 'build/rasterize-font'], { stdio: 'inherit' });
  execFileSync('build/rasterize-font', ['build/characters.json', 'build/chinese-tiles.bin', fontPath,
    String(translationFont.pointSize)], { stdio: 'inherit' });
  const tiles = readFileSync('build/chinese-tiles.bin');
  validateGlyphTiles(characters, tiles);
  const result = buildPrototype(source, catalog, characters, tiles);
  result.manifest.font = { ...translationFont, adaptation: 'Native monochrome 8x8 supplement; original Japanese glyphs preserved' };
  const prefix = 'build/momotarou-zh-Hant-menu-prototype';
  writeFileSync(`${prefix}.gba`, result.rom);
  writeFileSync(`${prefix}.ips`, result.patch);
  writeFileSync(`${prefix}.json`, JSON.stringify(result.manifest, null, 2) + '\n');
  const licenseRoot = 'assets/fonts/fusion-pixel-2026.09.01/LICENSES';
  const notices = readdirSync(licenseRoot, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => `${entry.parentPath}/${entry.name}`).sort();
  writeFileSync(`${prefix}-font-licenses.txt`, [translationFont.licensePath, ...notices]
    .map(path => `${path}\n\n${readFileSync(path, 'utf8')}`).join('\n\n'));
  writeFileSync('build/chinese-tiles.ppm', tileSheet(tiles));
  console.log(`Built ${catalog.entries.length}-label prototype with ${characters.length} Chinese glyphs: ${prefix}.gba`);
}