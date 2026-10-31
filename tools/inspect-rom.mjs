import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const SOURCE_SHA256 = '938fa27a934ac3f4fa93d4d9e49bd538c2fb41040d0f7a8b2de6343a406f82d3';
export const DEFAULT_SOURCE = 'assets/Momotarou Matsuri (J)(Rapid Fire).zip';

export function readRom(source = DEFAULT_SOURCE) {
  if (!source.toLowerCase().endsWith('.zip')) return readFileSync(source);
  const entries = execFileSync('unzip', ['-Z1', source], { encoding: 'utf8' })
    .trim().split('\n').filter(entry => entry.toLowerCase().endsWith('.gba'));
  if (entries.length !== 1) throw new Error('Expected exactly one GBA ROM in the archive.');
  return execFileSync('unzip', ['-p', source, entries[0]], { maxBuffer: 32 * 1024 * 1024 });
}

export function inspectRom(rom) {
  const sha256 = createHash('sha256').update(rom).digest('hex');
  if (sha256 !== SOURCE_SHA256) throw new Error(`Unsupported source ROM: ${sha256}`);
  let checksum = 0;
  for (let offset = 0xa0; offset <= 0xbc; offset++) checksum -= rom[offset];
  const references = new Map();
  for (let offset = 0; offset + 4 <= rom.length; offset += 4) {
    const target = rom.readUInt32LE(offset) - 0x08000000;
    if (target < 0 || target >= rom.length) continue;
    if (!references.has(target)) references.set(target, []);
    references.get(target).push(offset);
  }
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const japaneseStrings = [];
  for (const [offset, pointerOffsets] of references) {
    const end = rom.indexOf(0, offset);
    if (end < offset + 4 || end > offset + 256) continue;
    try {
      const text = decoder.decode(rom.subarray(offset, end));
      if (!/^[\x20-\x7e\u3000-\u30ff\u3400-\u9fff\uff01-\uff60]+$/u.test(text)) continue;
      if (!/[\u3040-\u30ff]/u.test(text)) continue;
      japaneseStrings.push({ offset, pointerOffsets, text });
    } catch {}
  }
  let paddingStart = rom.length;
  while (paddingStart > 0 && rom[paddingStart - 1] === 0xff) paddingStart--;
  const pointerBlocks = [];
  for (let start = 0; start < rom.length; start += 0x10000) {
    let count = 0;
    for (let offset = start; offset + 4 <= Math.min(start + 0x10000, rom.length); offset += 4) {
      const target = rom.readUInt32LE(offset) - 0x08000000;
      if (target >= 0 && target < rom.length) count++;
    }
    if (count >= 100) pointerBlocks.push({ start, count });
  }
  return {
    sha256,
    size: rom.length,
    title: rom.subarray(0xa0, 0xac).toString('ascii'),
    gameCode: rom.subarray(0xac, 0xb0).toString('ascii'),
    revision: rom[0xbc],
    headerChecksumValid: ((checksum - 0x19) & 0xff) === rom[0xbd],
    trailingPadding: { offset: paddingStart, length: rom.length - paddingStart },
    pointerBlocks,
    japaneseStrings: japaneseStrings.sort((first, second) => first.offset - second.offset),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(inspectRom(readRom(process.argv[2])), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}