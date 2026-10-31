import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeIps, applyPrototypeIps } from './build-prototype.mjs';
import { validateGlyphTiles } from './font.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const handDialogue = process.argv.includes('--hand-dialogue');
const basePrefix = handDialogue ? 'build/score-fix-miseki-QCwnps/momotarou-zh-Hant' : 'build/score-fix-P61K4j/momotarou-zh-Hant';
const base = readFileSync(`${basePrefix}.gba`);
const manifest = JSON.parse(readFileSync(`${basePrefix}.json`));
assert.equal(hash(base), handDialogue
  ? '03b59d6022a0f9cdb86b10c38ba91b371a85dd5eda5695dd3c56ea2855bd9fb4'
  : '69e5cec925b6712e5b0965f69a5e9630fb9d188a5dac646aea19614d4197ae29');
assert.equal(manifest.outputSha256, hash(base));
const font = {
  name: 'Miseki Bitmap Mincho v1.15.2 (comparison G)',
  path: 'assets/fonts/miseki-bitmap-1.15.2/MisekiBitmapMincho.ttf',
  sha256: '61f19210843061cdf4d30bef5a35261b764c521e1c5613205d9c2dd834ccf8aa',
  pointSize: 8, cellSize: 8, license: 'SIL-OFL-1.1',
  licensePath: 'assets/fonts/miseki-bitmap-1.15.2/OFL.txt',
  source: 'https://github.com/ItMarki/MisekiBitmap/releases/tag/v1.15.2',
  adaptation: 'Native 8px monochrome outlines; one 8x8 tile per character; embedded bitmaps bypassed; original Japanese glyphs preserved',
};
assert.equal(hash(readFileSync(font.path)), font.sha256);
const characters = JSON.parse(readFileSync('build/dialogue-characters.json'));
assert.equal(characters.length, manifest.dynamicGlyphCount);
const allocation = manifest.allocations.find(item => item.label === 'dynamic-glyph-library');
assert.equal(allocation.offset, manifest.tilesOffset);
assert.equal(allocation.size, characters.length * 32);
assert.equal(base.readUInt32LE(manifest.allocations.find(item => item.label === 'dynamic-glyph-count').offset), characters.length);
const directory = mkdtempSync(handDialogue ? 'build/score-fix-hand-I-' : 'build/score-fix-miseki-');
const tilesPath = join(directory, 'glyphs.bin');
let handSample;
if (handDialogue) {
  const comparison = join(directory, 'compare-fonts');
  execFileSync('swiftc', ['tools/compare-8px-fonts.swift', '-o', comparison]);
  execFileSync(comparison, ['--hand-dialogue']);
  handSample = JSON.parse(readFileSync('build/font-comparison-hand-dialogue.json'));
  const tiles = Buffer.from(base.subarray(allocation.offset, allocation.offset + allocation.size));
  assert.equal(handSample.baselineSha256, hash(tiles));
  assert.equal(handSample.cellSize, 8);
  assert.equal(handSample.editedCount, 11);
  assert.equal(handSample.corpusCollisionCount, 0);
  assert.equal(Object.keys(handSample.editedRows).length, 11);
  for (const [character, rows] of Object.entries(handSample.editedRows)) {
    const index = characters.indexOf(character);
    assert.ok(index >= 0);
    assert.equal(rows.length, 8);
    for (const [row, bits] of rows.entries()) {
      assert.ok(Number.isInteger(bits) && bits >= 0 && bits <= 255);
      for (let pair = 0; pair < 4; pair++) {
        const left = bits & (0x80 >> (pair * 2)) ? 2 : 1;
        const right = bits & (0x80 >> (pair * 2 + 1)) ? 2 : 1;
        tiles[index * 32 + row * 4 + pair] = left | (right << 4);
      }
    }
  }
  writeFileSync(tilesPath, tiles);
  font.name = 'Miseki Bitmap Mincho with 11 hand-edited glyphs (comparison I trial)';
  font.adaptation = 'Eleven hand-edited 8x8 CJK glyphs; remaining G glyphs and native Japanese tiles preserved; not a complete new font';
} else {
  execFileSync('swiftc', ['tools/rasterize-font.swift', '-o', join(directory, 'rasterize-font')]);
  execFileSync(join(directory, 'rasterize-font'), ['build/dialogue-characters.json', tilesPath, font.path, '8', '8', '--outline']);
}
const tiles = readFileSync(tilesPath);
validateGlyphTiles(characters, tiles);
const output = Buffer.from(base);
tiles.copy(output, allocation.offset);
assert.deepEqual(output.subarray(0, allocation.offset), base.subarray(0, allocation.offset));
assert.deepEqual(output.subarray(allocation.offset + allocation.size), base.subarray(allocation.offset + allocation.size));
const changedGlyphs = characters.filter((_, index) => !tiles.subarray(index * 32, index * 32 + 32)
  .equals(base.subarray(allocation.offset + index * 32, allocation.offset + index * 32 + 32)));
assert.ok(changedGlyphs.length > 0);
if (handDialogue) assert.deepEqual([...changedGlyphs].sort(), Object.keys(handSample.editedRows).sort());
const original = readFileSync('build/0023 - Momotarou Matsuri (J)(Rapid Fire).gba');
assert.equal(hash(original), manifest.sourceSha256);
const patch = makeIps(original, output);
assert.deepEqual(applyPrototypeIps(original, patch), output);
const prefix = join(directory, 'momotarou-zh-Hant');
const report = {
  ...manifest, outputSha256: hash(output), font,
  fontReplacement: {
    basePrefix, baseSha256: hash(base), tilesOffset: allocation.offset, tilesBytes: tiles.length,
    tilesSha256: hash(tiles), charactersSha256: hash(readFileSync('build/dialogue-characters.json')),
    changedGlyphs, unchangedOutsideGlyphLibrary: true, ipsRoundtrip: true,
    ...(handDialogue ? { handSample, partialFont: true } : {}),
    status: 'local-candidate-not-deployed',
    limitations: ['Original native glyphs and static 10px preview remain unchanged.',
      'Existing mountain-race timing regression remains; this is not a full release.',
      'Hardware gameplay and cross-build save loading remain unverified.'],
  },
};
writeFileSync(`${prefix}.gba`, output);
writeFileSync(`${prefix}.ips`, patch);
writeFileSync(`${prefix}.json`, `${JSON.stringify(report, null, 2)}\n`);
writeFileSync(`${prefix}-font-licenses.txt`, `${font.name}\n${font.source}\n${font.adaptation}\n\n${readFileSync(font.licensePath, 'utf8')}\n\nRetained base font notices (original assets and 10px preview):\n${readFileSync(`${basePrefix}-font-licenses.txt`, 'utf8')}`);
console.log(prefix);