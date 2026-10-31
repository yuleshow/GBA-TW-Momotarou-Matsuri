import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readRom, inspectRom, SOURCE_SHA256 } from './inspect-rom.mjs';
import { decodePairs } from './font.mjs';

const hex = value => `0x${value.toString(16)}`;
const resourceCache = new Map();

export function inspectTextPointerResources(source) {
assert.equal(source.length, 0x400000);
const sourceSha256 = createHash('sha256').update(source).digest('hex');
assert.equal(sourceSha256, SOURCE_SHA256, 'Resource ownership evidence requires verified ROM');
if (resourceCache.has(sourceSha256)) return resourceCache.get(sourceSha256);
const references = new Map();
for (let pointer = 0; pointer + 4 <= source.length; pointer += 4) {
  const target = source.readUInt32LE(pointer) - 0x08000000;
  if (target < 0 || target >= source.length) continue;
  if (!references.has(target)) references.set(target, []);
  references.get(target).push(pointer);
}
function decodeWordLz(data) {
  const size = data.readUIntLE(1, 3);
  assert.equal(data[0], 0xe0);
  assert.equal(size % 2, 0);
  const decoded = Buffer.alloc(size);
  const dictionary = new Uint16Array(1024);
  let ring = 0x3be;
  let cursor = 4;
  let written = 0;
  while (written < size) {
    assert.ok(cursor < data.length);
    const flags = data[cursor++];
    for (let bit = 0; bit < 8 && written < size; bit++) {
      const token = data.readUInt16LE(cursor);
      cursor += 2;
      let index = token >>> 6;
      const count = flags & (1 << bit) ? (token & 63) + 3 : 1;
      for (let repeat = 0; repeat < count; repeat++) {
        const value = flags & (1 << bit) ? dictionary[index++ & 1023] : token;
        decoded.writeUInt16LE(value, written);
        written += 2;
        dictionary[ring++ & 1023] = value;
      }
    }
  }
  assert.equal((data.length - cursor) % 2, 0);
  while (cursor < data.length) {
    assert.equal(data.readUInt16LE(cursor), 0x00ff);
    cursor += 2;
  }
  return decoded;
}

function decodeResource(bytes, start) {
  if (bytes[start] === 0x90) return decodePairs(bytes, start);
  assert.equal(bytes[start], 0x80);
  const scratch = Buffer.from(bytes.subarray(start));
  const intermediateSize = scratch.readUInt32BE(4);
  scratch.writeUInt32LE(intermediateSize * 256 + 0x90, 0);
  const intermediate = decodePairs(scratch, 0);
  const data = decodeWordLz(intermediate.data);
  assert.equal(data.length, bytes.readUIntLE(start + 1, 3));
  return { data, consumed: intermediate.consumed, intermediateBytes: intermediate.data.length };
}

const packed = [];
for (let start = 0; start + 8 <= source.length; start += 4) {
  if (![0x80, 0x90].includes(source[start]) || !source.readUIntLE(start + 1, 3) ||
      source.readUIntLE(start + 1, 3) > 0x100000 || !source.readUInt32BE(start + 4) ||
      source.readUInt32BE(start + 4) > 0x100000) continue;
  try {
    const decoded = decodeResource(source, start);
    packed.push({ kind: source[start] === 0x80 ? 'pairs-word-lz' : 'pairs', header: start, start: start + 8,
      end: start + decoded.consumed, decodedBytes: decoded.data.length,
      intermediateBytes: decoded.intermediateBytes,
      references: references.get(start) ?? [] });
  } catch {}
}
assert.equal(source.subarray(0x43ec8, 0x43ed6).toString('hex'), '0006034a800d8018006840187047');
const relativeResources = [
  [0x208d50, 0x16874c, 0x168a0c], [0x1fd2a4, 0x16874c, 0x13400c],
  [0x1d934c, 0x168744, 0x132280], [0x19deb4, 0x168744, 0x131c50],
  [0x18e770, 0x168744, 0x131a7c],
];
for (const [header, basePointer, offsetPointer] of relativeResources) {
  const base = source.readUInt32LE(basePointer) - 0x08000000;
  const displacement = source.readUInt32LE(offsetPointer);
  assert.equal(base + displacement, header);
  const span = packed.find(candidate => candidate.header === header);
  assert.ok(span);
  span.relativeReference = { lookup: hex(0x43ec8), basePointer: hex(basePointer),
    base: hex(base), offsetPointer: hex(offsetPointer), displacement: hex(displacement) };
}
const banks = new Map();
for (let songPointer = 0x514d0; songPointer < 0x51968; songPointer += 8) {
  const song = source.readUInt32LE(songPointer) - 0x08000000;
  if (song === 0x51968) continue;
  assert.ok(song >= 0 && song + 8 <= source.length);
  const tracks = source[song];
  assert.ok(tracks > 0 && tracks <= 16);
  const bank = source.readUInt32LE(song + 4) - 0x08000000;
  assert.ok(bank >= 0 && bank + 12 <= source.length);
  if (!banks.has(bank)) banks.set(bank, { songPointer, song, bank });
}
const samples = new Map();
for (const [bank, chain] of banks) {
  const bankEnd = Math.min(bank + 128 * 12, ...[...banks.keys()].filter(next => next > bank));
  for (let instrument = 0; instrument < 128; instrument++) {
    const record = bank + instrument * 12;
    if (record + 12 > bankEnd || record + 12 > source.length) break;
    if (![0, 8].includes(source[record])) continue;
    const wave = source.readUInt32LE(record + 4) - 0x08000000;
    if (wave < 0 || wave + 16 > source.length || wave % 4) continue;
    const type = source.readUInt16LE(wave);
    const flags = source.readUInt16LE(wave + 2);
    const frequency = source.readUInt32LE(wave + 4);
    const loop = source.readUInt32LE(wave + 8);
    const length = source.readUInt32LE(wave + 12);
    if (type !== 0 || ![0, 0x4000].includes(flags) || !frequency || !length ||
        loop > length || wave + 16 + length > source.length) continue;
    if (!samples.has(wave)) samples.set(wave, { kind: 'pcm', header: wave,
      start: wave + 16, end: wave + 16 + length, frequency, loop, flags,
      chain: { ...chain, instrument, record, wavePointer: record + 4 } });
  }
}
const spans = [...packed, ...samples.values()];
const containing = pointer => spans.filter(span => pointer >= span.start && pointer + 4 <= span.end);
for (const [pointer, header] of [[0x297730, 0x29718c], [0xa2b2c, 0xa2684],
  [0xd2924, 0xc9e00], [0x3ce044, 0x3cc6d0]]) {
  assert.ok(containing(pointer).some(span => span.header === header), `Missing known payload ${hex(pointer)}`);
}
assert.equal(source.readUInt32LE(0x48390), 0x080514d0);
for (const span of packed) {
  span.references = span.references.filter(pointer => containing(pointer).length === 0);
}
const verifiedSpans = spans.filter(span => span.kind === 'pcm' || span.relativeReference || span.references.length);
const result = { spans, verifiedSpans, sourceReferences: references, pairResources: packed.length, songBanks: banks.size,
  directPcmSamples: samples.size,
  containers: (pointer, size = 4) => verifiedSpans.filter(span => pointer < span.end && pointer + size > span.header),
  decodeResource };
resourceCache.set(sourceSha256, result);
return result;
}

export function filterTextPointers(source, pointers) {
  const resources = source.length === 0x400000 ? inspectTextPointerResources(source) : undefined;
  const rejectedPointerOffsets = pointers.filter(pointer => resources?.containers(pointer).length);
  return { sourcePointerOffsets: [...pointers],
    pointerOffsets: pointers.filter(pointer => !rejectedPointerOffsets.includes(pointer)), rejectedPointerOffsets };
}

export function changedResourceSpans(source, output) {
  assert.ok(output.length >= source.length, 'Output truncates original ROM');
  const resources = inspectTextPointerResources(source);
  return resources.spans.filter(span => !source.subarray(span.header, span.end).equals(output.subarray(span.header, span.end)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
const source = readRom(process.argv[2]);
const metadata = inspectRom(source);
const manifest = JSON.parse(readFileSync(process.argv[3] ?? 'build/momotarou-zh-Hant.json'));
assert.equal(manifest.sourceSha256, metadata.sha256);
const output = readFileSync(process.argv[4] ?? 'build/momotarou-zh-Hant.gba');
assert.equal(createHash('sha256').update(output).digest('hex'), manifest.outputSha256);
const { spans, sourceReferences, containers: containing, decodeResource, pairResources, songBanks, directPcmSamples } = inspectTextPointerResources(source);
const describe = span => ({ ...span, header: hex(span.header), start: hex(span.start), end: hex(span.end),
  references: span.references?.map(hex),
  chain: span.chain && Object.fromEntries(Object.entries(span.chain).map(([key, value]) =>
    [key, key === 'instrument' ? value : hex(value)])) });
const findings = [];
const outside = [];
const rejectedReferences = [];
const excluded = manifest.fullCorpus?.blocked.filter(entry => entry.status === 'non-text-reference-not-installed') ?? [];
for (const entry of [...manifest.translated, ...excluded]) {
  const target = typeof entry.offset === 'number' ? entry.offset : Number.parseInt(entry.offset, 16);
  const originalPointers = sourceReferences.get(target) ?? [];
  assert.deepEqual(entry.sourcePointerOffsets ?? entry.pointerOffsets, originalPointers, `Incomplete source evidence: ${entry.offset}`);
  if (entry.sourcePointerOffsets) {
    const evidence = filterTextPointers(source, originalPointers);
    assert.deepEqual(entry.pointerOffsets, evidence.pointerOffsets, `Incorrect installed references: ${entry.offset}`);
    assert.deepEqual(entry.rejectedPointerOffsets, evidence.rejectedPointerOffsets);
    for (const pointer of evidence.rejectedPointerOffsets) rejectedReferences.push({ entry: entry.offset,
      pointer: hex(pointer), changed: source.readUInt32LE(pointer) !== output.readUInt32LE(pointer),
      containers: containing(pointer).map(describe) });
  }
}
let pointerCount = 0;
for (const entry of manifest.translated) {
  const target = typeof entry.offset === 'number' ? entry.offset : Number.parseInt(entry.offset, 16);
  for (const pointer of entry.pointerOffsets) {
    pointerCount++;
    assert.equal(source.readUInt32LE(pointer), 0x08000000 + target);
    const containers = containing(pointer);
    if (!containers.length) {
      if (pointer >= 0x52000 && (pointer < 0x130000 || pointer >= 0x169000)) {
        outside.push({ entry: entry.offset, pointer: hex(pointer) });
      }
      continue;
    }
    for (const span of containers.filter(candidate => candidate.kind !== 'pcm')) {
      if (span.outputCheck) continue;
      try {
        const original = decodeResource(source, span.header);
        const modified = decodeResource(output, span.header);
        span.outputCheck = { decodes: true, equal: original.data.equals(modified.data),
          consumed: modified.consumed, decodedBytes: modified.data.length };
      } catch (error) {
        span.outputCheck = { decodes: false, error: error.message };
      }
    }
    findings.push({ entry: entry.offset, pointer: hex(pointer),
      before: hex(source.readUInt32LE(pointer)), after: hex(output.readUInt32LE(pointer)),
      changed: source.readUInt32LE(pointer) !== output.readUInt32LE(pointer),
      otherAcceptedPointers: entry.pointerOffsets.filter(value => value !== pointer).map(value =>
        ({ pointer: hex(value), alsoInPayload: containing(value).length > 0 })),
      containers: containers.map(describe) });
  }
}
console.log(JSON.stringify({ sourceSha256: metadata.sha256, outputSha256: manifest.outputSha256,
  entries: manifest.translated.length, pointerCount, pairResources,
  songBanks, directPcmSamples, knownPayloadChecks: 4,
  resourceSpans: spans.length, affectedResourceChanges: changedResourceSpans(source, output).map(describe),
  findings, rejectedReferences, excludedEntries: excluded.length, unmatchedLatePointers: outside,
  limits: '0x90 and 0x80 headers (aligned, sizes <=1 MiB) are decoded candidates until external references are verified. PCM discovery checks direct instruments 0..127, bounded at the next song-rooted bank; instrument selection, indirect banks, other codecs, computed references and gameplay reachability are not certified. All intervals are half-open. Reads only; JSON goes to stdout.' }, null, 2));
}