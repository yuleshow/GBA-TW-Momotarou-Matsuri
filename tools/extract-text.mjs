import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectRom, readRom } from './inspect-rom.mjs';

export function characterMap(rom) {
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const characters = new Map();
  for (let code = 0x20; code < 0x60; code++) characters.set(code, String.fromCharCode(code));
  for (const bank of [
    { table: 0x167a8f, start: 0x829f, count: 83, base: 0x60 },
    { table: 0x167ae2, start: 0x8340, count: 84, base: 0xb0 },
  ]) {
    for (let index = 0; index < bank.count; index++) {
      const code = rom.readInt8(bank.table + index);
      if (code < 0) continue;
      const sjis = bank.start + index;
      const character = decoder.decode(Uint8Array.of(sjis >> 8, sjis & 0xff));
      characters.set(bank.base + code, character);
    }
  }
  return characters;
}

export function decodeText(bytes, characters) {
  const tokens = [];
  for (let index = 0; index < bytes.length; index++) {
    const code = bytes[index];
    const hex = code.toString(16).padStart(2, '0').toUpperCase();
    if (code === 3 && index + 1 < bytes.length) {
      tokens.push(`<03:${bytes[++index].toString(16).padStart(2, '0').toUpperCase()}>`);
    } else if (code === 5 && index + 1 < bytes.length) {
      tokens.push(`<KANJI:${bytes[++index].toString(16).padStart(2, '0').toUpperCase()}>`);
    } else if (code === 6 && index + 1 < bytes.length) {
      tokens.push(`<06:${bytes[++index].toString(16).padStart(2, '0').toUpperCase()}>`);
    } else if (code === 10) {
      tokens.push('\n');
    } else {
      tokens.push(characters.get(code) ?? `<${hex}>`);
    }
  }
  return tokens.join('');
}

export function findTextEnd(bytes, offset, limit = bytes.length) {
  if (!Number.isInteger(offset) || !Number.isInteger(limit) ||
      offset < 0 || limit < offset || limit > bytes.length) {
    throw new RangeError('Invalid text scan bounds');
  }
  for (let cursor = offset; cursor < limit; cursor++) {
    const code = bytes[cursor];
    if (code === 0) return cursor;
    if (code === 3 || code === 5 || code === 6) cursor++;
  }
  return -1;
}

export function extractCandidates(rom) {
  const metadata = inspectRom(rom);
  const characters = characterMap(rom);
  const references = new Map();
  for (let offset = 0; offset + 4 <= rom.length; offset += 4) {
    const target = rom.readUInt32LE(offset) - 0x08000000;
    if (target < 0x12fff4 || target >= 0x1679ae) continue;
    if (!references.has(target)) references.set(target, []);
    references.get(target).push(offset);
  }
  const entries = new Map();
  const addCandidate = (offset, end, boundaryMethod) => {
    const bytes = rom.subarray(offset, end);
    const text = decodeText(bytes, characters);
    const kana = [...text.matchAll(/[\u3040-\u30ff]/gu)].length;
    let suspiciousControls = 0;
    for (let index = 0; index < bytes.length; index++) {
      const code = bytes[index];
      if (code < 0x20 && ![3, 4, 5, 6, 7, 9, 10, 13, 14, 0x1b, 0x1d].includes(code)) {
        suspiciousControls++;
      }
      if (boundaryMethod === 'pointer-control-aware' && [3, 5, 6].includes(code)) index++;
    }
    if (bytes.length >= 2 && bytes.length <= 4096 && kana >= 2 &&
        kana / bytes.length >= 0.25 && suspiciousControls === 0) {
      entries.set(offset, {
        id: offset.toString(16).padStart(6, '0'),
        offset,
        byteLength: bytes.length,
        rawHex: bytes.toString('hex'),
        pointerOffsets: references.get(offset) ?? [],
        boundaryMethod,
        source: text,
        translation: '',
        status: 'candidate-unverified',
      });
    }
  };
  for (let offset = 0x12fff4; offset < 0x1679ae;) {
    const end = rom.indexOf(0, offset);
    if (end < 0 || end >= 0x1679ae) break;
    addCandidate(offset, end, 'nul-heuristic');
    offset = end + 1;
  }
  for (const offset of references.keys()) {
    const end = findTextEnd(rom, offset, Math.min(offset + 4097, 0x1679ae));
    if (end >= 0) addCandidate(offset, end, 'pointer-control-aware');
  }
  return {
    sourceSha256: metadata.sha256,
    targetLanguage: 'zh-Hant',
    warning: 'Heuristic candidates, not verified script boundaries or pointer ownership. Pointer-target scans understand only 03/05/06 operands. Entries may overlap. Unknown bytes and kanji remain tokens. Do not insert these entries into a ROM.',
    entries: [...entries.values()].sort((left, right) => left.offset - right.offset),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outputDirectory = process.argv[3] ?? 'build';
    const catalog = extractCandidates(readRom(process.argv[2]));
    mkdirSync(outputDirectory, { recursive: true });
    const outputPath = join(outputDirectory, 'text-candidates.json');
    writeFileSync(outputPath, JSON.stringify(catalog, null, 2) + '\n');
    console.log(`Extracted ${catalog.entries.length} unverified candidates to ${outputPath}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}