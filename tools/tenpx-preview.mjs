import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const width = 192;
const height = 48;
const cellSize = 10;
const columns = 18;
const rows = 3;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const romPath = 'build/momotarou-zh-Hant.gba';
const rom = readFileSync(romPath);
assert.equal(hash(rom), '964a8fd57faf7911275dd3243e4d3938630a4498d74d2ab74a0bdf4912a35d2c');
const saves = ['build/momotarou-zh-Hant.sav', 'build/momotarou-zh-Hant-silver-large-experimental.sav']
  .filter(existsSync).map(path => [path, hash(readFileSync(path))]);
const manifest = JSON.parse(readFileSync('build/momotarou-zh-Hant.json'));
const characters = JSON.parse(readFileSync('build/dialogue-characters.json'));
const fontPath = 'assets/fonts/fusion-pixel-10px-2026.09.25/fusion-pixel-10px-monospaced-zh_hant.ttf';
const directory = mkdtempSync('build/tenpx-');

function plainPage(markup) {
  const tokens = markup.match(/<[^>]+>|[^<]+/gu) ?? [];
  assert.equal(tokens.join(''), markup);
  const replacements = new Map([
    ['<KANJI:80>', '\u6843'], ['<KANJI:81>', '\u592a'], ['<KANJI:82>', '\u90ce'],
    ['<06:14>', ''], ['<06:15>', ''], ['<1B>', ''], ['<1D>', ''], ['<0D>', ''],
  ]);
  return tokens.map(token => {
    if (!token.startsWith('<')) return token;
    assert.ok(replacements.has(token), `Unsupported preview token: ${token}`);
    return replacements.get(token);
  }).join('').trim().replace(/\n\n/gu, '\n');
}

function layout(text) {
  const placements = [];
  let row = 0;
  let column = 0;
  for (const character of text) {
    if (character === '\n') {
      row++;
      column = 0;
      continue;
    }
    if (column === columns) {
      row++;
      column = 0;
    }
    assert.ok(row < rows, 'Preview text exceeds three whole-glyph rows');
    placements.push({ character, left: 4 + column * cellSize, top: 4 + row * 14 });
    column++;
  }
  return placements;
}

function pack(pixels) {
  const tiles = Buffer.alloc(width * height / 2);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const tile = Math.floor(row / 8) * (width / 8) + Math.floor(column / 8);
      const offset = tile * 32 + (row % 8) * 4 + Math.floor((column % 8) / 2);
      tiles[offset] |= pixels[row * width + column] << ((column % 2) * 4);
    }
  }
  return tiles;
}

const boundary = layout('A'.repeat(19));
assert.deepEqual(boundary[17], { character: 'A', left: 174, top: 4 });
assert.deepEqual(boundary[18], { character: 'A', left: 4, top: 18 });
assert.throws(() => layout('A'.repeat(55)), /exceeds/);
const pages = manifest.translated.find(entry => entry.offset === '1551d8').translation
  .split('<09>').map(plainPage).filter(Boolean);
assert.equal(pages.length, 7);
const previewCharacters = [...new Set([...characters, ...pages.join('').replace(/\n/gu, '')])];
const characterPath = join(directory, 'characters.json');
writeFileSync(characterPath, JSON.stringify(previewCharacters));
execFileSync('swiftc', ['tools/rasterize-font.swift', '-o', join(directory, 'rasterize-font')]);
execFileSync(join(directory, 'rasterize-font'), [characterPath, join(directory, 'glyphs.bin'), fontPath, '10', '10'], { stdio: 'inherit' });
const glyphs = readFileSync(join(directory, 'glyphs.bin'));
assert.equal(glyphs.length, previewCharacters.length * 100);
assert.ok(glyphs.every(pixel => pixel === 1 || pixel === 2));
execFileSync(join(directory, 'rasterize-font'), ['build/dialogue-characters.json', join(directory, 'original8.bin'),
  'assets/fonts/fusion-pixel-2026.09.01/fusion-pixel-8px-monospaced-zh_hant.ttf', '8', '8'], { stdio: 'inherit' });
assert.deepEqual(readFileSync(join(directory, 'original8.bin')),
  rom.subarray(manifest.tilesOffset, manifest.tilesOffset + characters.length * 32));
const glyphMap = new Map(previewCharacters.map((character, index) => [character, glyphs.subarray(index * 100, (index + 1) * 100)]));
const packedPages = pages.map(text => {
  const pixels = Buffer.alloc(width * height, 1);
  const placements = layout(text);
  for (const { character, left, top } of placements) {
    const glyph = glyphMap.get(character);
    assert.ok(glyph && glyph.includes(2), `Missing or blank glyph: ${character}`);
    assert.ok(left + cellSize <= width && top + cellSize <= height);
    for (let row = 0; row < cellSize; row++) {
      glyph.copy(pixels, (top + row) * width + left, row * cellSize, (row + 1) * cellSize);
    }
  }
  const tiles = pack(pixels);
  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const tile = Math.floor(row / 8) * 24 + Math.floor(column / 8);
      const offset = tile * 32 + (row % 8) * 4 + Math.floor((column % 8) / 2);
      assert.equal((tiles[offset] >> ((column % 2) * 4)) & 15, pixels[row * width + column]);
    }
  }
  return tiles;
});
writeFileSync(join(directory, 'pages.bin'), Buffer.concat(packedPages));
execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I/opt/homebrew/opt/mgba/include',
  'build/tenpx-preview.c', '-L/opt/homebrew/opt/mgba/lib', '-lmgba', '-o', join(directory, 'preview')]);
const capturePrefix = `${directory}-live`;
const result = execFileSync(join(directory, 'preview'), [romPath, join(directory, 'pages.bin'), capturePrefix], { encoding: 'utf8' });
assert.equal(hash(readFileSync(romPath)), hash(rom));
for (const [path, expected] of saves) assert.equal(hash(readFileSync(path)), expected);
const report = {
  status: 'house-only-memory-preview-not-installed-in-ROM', fontPath, fontSha256: hash(readFileSync(fontPath)),
  cellSize, linePitch: 14, columns, rows, pages, rasterizedCharacters: previewCharacters.length,
  original8pxUnchanged: true, romSha256: hash(rom), savesUnchanged: true,
  runtime: result.trim(), screenshots: pages.map((_, index) => `${capturePrefix}-page-${index + 1}.png`),
  limits: ['Host uploads complete pages in VBlank; no production ARM renderer yet.',
    'Separate preview area above original dialogue; original portrait and 8px dialogue remain.',
    'Only the verified Mode 0 house scene; no battle/minigame allocation claim.',
    'Frame-boundary comparisons do not exclude transient CPU/DMA writes.',
    'No timing benchmark for on-GBA composition or native typewriter integration.'],
};
writeFileSync(join(directory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));