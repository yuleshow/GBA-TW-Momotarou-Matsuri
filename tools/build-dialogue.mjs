import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyPrototypeIps, makeIps, translationFont } from './build-prototype.mjs';
import { inspectRom, readRom, SOURCE_SHA256 } from './inspect-rom.mjs';
import { characterMap, decodeText, extractCandidates, findTextEnd } from './extract-text.mjs';
import { validateGlyphTiles } from './font.mjs';
import { changedResourceSpans, filterTextPointers } from './audit-text-pointers.mjs';

export function dialogueSource(source, offset) {
  assert.ok(Number.isInteger(offset) && offset > 0 && offset < source.length);
  const end = findTextEnd(source, offset, Math.min(offset + 1024, source.length));
  assert.ok(end > offset, `Unterminated or oversized dialogue at ${offset.toString(16)}`);
  return source.subarray(offset, end);
}

function entryOffset(value) {
  assert.ok(Number.isInteger(value) || (typeof value === 'string' && /^(?:0x)?[0-9a-f]+$/i.test(value)),
    `Invalid source offset: ${value}`);
  const offset = typeof value === 'number' ? value : Number.parseInt(value, 16);
  assert.ok(Number.isSafeInteger(offset) && offset > 0, 'Invalid source offset');
  return offset;
}

export function readFullShards(directory = 'translations') {
  return readdirSync(directory).filter(name => /^full-.*\.zh-Hant\.json$/.test(name)).sort()
    .map(name => ({ ...JSON.parse(readFileSync(join(directory, name), 'utf8')), name }));
}

export function sourceTokens(bytes, characters, { offsets } = {}) {
  const tokens = [];
  for (let cursor = 0; cursor < bytes.length; cursor++) {
    offsets?.add(cursor);
    const code = bytes[cursor];
    const hex = code.toString(16).padStart(2, '0').toUpperCase();
    if ([3, 5, 6].includes(code)) {
      assert.ok(cursor + 1 < bytes.length, `Dangling control ${hex}`);
      const operand = bytes[++cursor].toString(16).padStart(2, '0').toUpperCase();
      tokens.push(`<${code === 5 ? 'KANJI' : hex}:${operand}>`);
    } else if (code === 0x25) {
      const format = bytes.subarray(cursor).toString('latin1').match(/^%[0-9]*[sd]/)?.[0];
      assert.ok(format, 'Unsupported or dangling format placeholder');
      tokens.push(`<FMT:${format}>`);
      cursor += format.length - 1;
    } else if (code === 10) tokens.push('\n');
    else if ([4, 9, 13, 14, 0x1b, 0x1d].includes(code)) tokens.push(`<${hex}>`);
    else {
      assert.ok(code >= 0x20 && characters.has(code), `Unreviewed source byte ${hex}`);
      tokens.push(characters.get(code));
    }
  }
  return tokens;
}

const stringArgumentEvidence = new Map([
  [0x1300ae, { pointers: [0x37c], pools: ['items'] }],
  [0x1300bb, { pointers: [0x3dc], pools: ['items'] }],
  [0x1300cf, { pointers: [0x40c], pools: ['items'], capacity: 64 }],
  [0x132cfc, { pointers: [0x906c], pools: ['items'] }],
  [0x132f27, { pointers: [0x91b8], pools: ['items'] }],
  [0x163b0e, { pointers: [0x9fb4], pools: ['rentals'], capacity: 20 }],
  [0x163b31, { pointers: [0xa994], pools: ['meals'], capacity: 20 }],
  [0x1334c0, { pointers: [0xa20c], pools: ['rentals'], decimalBytes: 5 }],
  [0x133606, { pointers: [0xabb8], pools: ['meals'], decimalBytes: 5 }],
  [0x133caf, { pointers: [0x854c], pools: ['items'], decimalBytes: 5 }],
  [0x133ccf, { pointers: [0x8548], pools: ['items'], decimalBytes: 5 }],
  [0x133dc1, { pointers: [0x86b4], pools: ['items'], decimalBytes: 5 }],
  [0x133d9f, { pointers: [0x86b8], pools: ['items'], decimalBytes: 5 }],
  [0x13a3c9, { pointers: [0x23af0, 0x23b5c], pools: ['directions'] }],
  [0x13a987, { pointers: [0x23b9c], pools: ['directions'] }],
  [0x13a592, { pointers: [0x24290], pools: ['directions'] }],
  [0x13a665, { pointers: [0x243a4], pools: ['directions'] }],
  [0x13a73e, { pointers: [0x24388], pools: ['directions'] }],
  [0x166352, { pointers: [0x25ab8], pools: ['titles'], decimalBytes: 5 }],
  [0x166333, { pointers: [0x25ac8], pools: ['titles'] }],
  [0x1677f4, { pointers: [0xd514], pools: ['items'] }],
  [0x166baf, { pointers: [0x2ce44], pools: ['boardNames', 'boardNames'] }],
  [0x163e26, { pointers: [0x3fa68], pools: ['rankNames'] }],
  [0x168305, { pointers: [0x4241c], pools: ['battleNames'] }],
  [0x16831d, { pointers: [0x42544, 0x426b8, 0x42754], pools: ['battleNames'] }],
  [0x168336, { pointers: [0x4275c], pools: ['battleNames'] }],
  [0x136159, { pointers: [0xbfa0], pools: ['items'] }],
  [0x136213, { pointers: [0xbfa8], pools: ['items'] }],
  [0x13624d, { pointers: [0xbfb8], pools: ['items'] }],
  [0x1361b5, { pointers: [0xbfd0], pools: ['items'] }],
  [0x1362ab, { pointers: [0xbcd8], pools: ['items'] }],
  [0x1362df, { pointers: [0xbcbc], pools: ['items'] }],
  [0x1363a3, { pointers: [0xbb6c], pools: ['items'] }],
  [0x136337, { pointers: [0xbc9c, 0xbcfc, 0xbe08, 0xbe34], pools: ['items'] }],
  [0x164130, { pointers: [0xbd88], pools: ['items'] }],
  [0x150c1e, { pointers: [0x3b818], pools: ['items'] }],
  [0x163f9c, { pointers: [0x27f0], pools: ['items'] }],
  [0x163ff3, { pointers: [0x282c], pools: ['companions'] }],
  [0x163bc9, { pointers: [0xb408], pools: ['titles', 'ranks'] }],
  [0x163beb, { pointers: [0xb42c], pools: ['titles', 'ranks'] }],
  [0x163b87, { pointers: [0xb4a0], pools: ['titles', 'ranks'] }],
  [0x163bab, { pointers: [0xb49c], pools: ['titles', 'ranks'] }],
  [0x163be3, { pointers: [0xb4c4], pools: ['titles'] }],
  [0x163b6c, { pointers: [0xb4fc], pools: ['titles', 'ranks'] }],
  [0x163d4f, { pointers: [0x3dfb4, 0x3e1a8], pools: ['titles'] }],
  [0x163d9a, { pointers: [0x3e0ac], pools: ['titles'] }],
  [0x139c1f, { pointers: [0x9a58], pools: ['maskParts'] }],
  [0x16500d, { pointers: [0x11910], pools: ['guessNames', 'guessNames'] }],
  [0x166ca5, { pointers: [0x4ca9c], pools: ['boardNames', 'boardNames'] }],
  [0x165ae7, { pointers: [0x16398], pools: ['raceOpponents'], capacity: 256 }],
  [0x16768c, { pointers: [0x3459c], pools: ['raceEntrants'], decimalBytes: 1 }],
]);

export function boundedStringArguments(source, entry, characters, selected = new Map()) {
  const evidence = stringArgumentEvidence.get(entryOffset(entry.offset));
  if (!evidence) return undefined;
  assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256, 'String caller evidence requires verified ROM');
  const pointers = [];
  for (let position = 0; position + 4 <= source.length; position += 4) {
    if (source.readUInt32LE(position) === entryOffset(entry.offset) + 0x08000000) pointers.push(position);
  }
  assert.deepEqual(pointers, evidence.pointers, 'String caller reference inventory changed');
  const pools = { items: [0x135950, 0x135a98], companions: [0x14242c, 0x142458],
    titles: [0x167d80, 0x167e14], ranks: [0x133fac, 0x133fd8],
    rentals: [0x133ed8, 0x133ef8], meals: [0x133f40, 0x133f50], directions: [0x13aa04, 0x13aa0c],
    boardNames: [0x4ca78, 0x4ca88], rankNames: [0x167f6c, 0x167f94], battleNames: [0x1685d8, 0x1685e8],
    maskParts: [0x133e64, 0x133e7c], guessNames: [0x4be80, 0x4beb8],
    raceOpponents: [0x19488, 0x19490], raceEntrants: [0x4cb00, 0x4ce48, 28] };
  return evidence.pools.map(name => {
    const [start, end, stride = 4] = pools[name];
    const variants = [];
    for (let pointer = start; pointer < end; pointer += stride) {
      const offset = source.readUInt32LE(pointer) - 0x08000000;
      let bytes = dialogueSource(source, offset);
      let parts = sourceTokens(bytes, characters);
      const replacement = selected.get(offset);
      if (replacement && (!replacement.strict || replacement.entry.status === 'translated-draft')) {
        assert.ok(!translationParts(replacement.entry.translation).some(part => part.startsWith('<FMT:')),
          `Dynamic argument ${offset.toString(16)} contains a format placeholder`);
        validateDialogueEntry(source, replacement.entry, characters, { strict: replacement.strict });
        parts = translationParts(replacement.entry.translation);
        bytes = encodeDialogue(replacement.entry.translation, [...new Set(parts.filter(part => !part.startsWith('<')))]).subarray(0, -1);
      }
      assert.ok(parts.every(part => !part.startsWith('<') || /^<KANJI:/.test(part) || ['<0D>', '<0E>', '<1B>', '<1D>'].includes(part)) &&
        !parts.includes('\n') && !bytes.includes(0), `Dynamic argument ${offset.toString(16)} is not a bounded single-line name`);
      const measured = [...bytes].filter(code => code !== 5).length;
      assert.ok(measured <= 255, 'Dynamic argument exceeds formatter length counter');
      variants.push({ bytes: bytes.length, columns: parts.length, measured });
    }
    return variants;
  });
}

function entrySourceTokens(bytes, entry, characters) {
  const encoding = entry.sourceEncoding ?? 'game_custom';
  assert.ok(['game_custom', 'shift_jis'].includes(encoding), `Unsupported sourceEncoding: ${encoding}`);
  if (encoding === 'game_custom') return sourceTokens(bytes, characters);
  const text = new TextDecoder('shift_jis', { fatal: true }).decode(bytes);
  assert.equal(text, entry.source, 'Shift-JIS source text changed');
  assert.ok(!/[\x00-\x1f\x7f%<>]/u.test(text), 'Unreviewed Shift-JIS source controls or formats');
  return [...text];
}

export function validateDialogueEncoding(bytes, entry, encoded, characters) {
  const original = entrySourceTokens(bytes, entry, characters);
  const controls = tokens => tokens.filter(token => /^<(?:03:|04>|06:|09>|0D>|0E>|1B>|1D>)/.test(token));
  assert.deepEqual(controls(translationParts(entry.translation)), controls(original), `Dialogue controls changed in ${entry.offset}`);
  const formats = [...encoded.toString('latin1').matchAll(/%[0-9]*[sd]/g)].map(match => `<FMT:${match[0]}>`);
  assert.deepEqual(formats, original.filter(token => token.startsWith('<FMT:')), `Format placeholders changed in ${entry.offset}`);
  assert.ok(encoded.length <= 680, `Formatted text buffer capacity risk in ${entry.offset}`);
}

export function validateDialogueEntry(source, entry, characters, { strict = false, references, selected } = {}) {
  const offset = entryOffset(entry.offset);
  assert.ok(offset < source.length, 'Source offset outside ROM');
  const pointers = references?.get(offset) ?? (() => {
    const found = [];
    for (let position = 0; position + 4 <= source.length; position += 4) {
      if (source.readUInt32LE(position) === 0x08000000 + offset) found.push(position);
    }
    return found;
  })();
  const pointerEvidence = filterTextPointers(source, pointers);
  const sourceEncoding = entry.sourceEncoding ?? 'game_custom';
  assert.ok(['game_custom', 'shift_jis'].includes(sourceEncoding), `Unsupported sourceEncoding: ${sourceEncoding}`);
  const shiftJis = sourceEncoding === 'shift_jis';
  let bytes;
  if (entry.sourceHex !== undefined) {
    assert.ok(typeof entry.sourceHex === 'string' && /^(?:[0-9a-f]{2})+$/i.test(entry.sourceHex), 'Invalid sourceHex');
    bytes = Buffer.from(entry.sourceHex, 'hex');
    assert.ok(offset + bytes.length < source.length, 'Source range outside ROM');
    assert.deepEqual(source.subarray(offset, offset + bytes.length), bytes, 'Source bytes changed');
    assert.equal(source[offset + bytes.length], 0, 'Source is not terminated at declared boundary');
    assert.equal(shiftJis ? source.indexOf(0, offset) : findTextEnd(source, offset, offset + bytes.length + 1), offset + bytes.length,
      'Source boundary contains an early terminator or dangling operand');
  } else {
    assert.ok(!strict && !shiftJis, 'Missing sourceHex evidence');
    bytes = dialogueSource(source, offset);
    assert.equal(decodeText(bytes, characters), entry.source, 'Source text changed');
  }
  assert.ok(typeof entry.translation === 'string' && entry.translation.length > 0, 'Empty translation');
  const original = entrySourceTokens(bytes, entry, characters);
  const parts = translationParts(entry.translation);
  if (shiftJis) {
    const pointer = new Map([[0x4d1e4, 0x13e824], [0x4d1f0, 0x13e820], [0x4d1fc, 0x13e81c],
      [0x4d208, 0x13e818], [0x4d214, 0x13e814]]).get(offset);
    assert.ok(pointer !== undefined, 'Unreviewed Shift-JIS renderer caller');
    assert.equal(createHash('sha256').update(source).digest('hex'), SOURCE_SHA256, 'Shift-JIS caller evidence requires verified ROM');
    assert.deepEqual(entry.pointerOffsets, [pointer], 'Shift-JIS caller pointer evidence changed');
    assert.ok(parts.every(part => !part.startsWith('<') && part !== '\n'), 'Shift-JIS selector requires literal single-line translation');
    assert.ok(parts.length <= 5, 'Shift-JIS selector exceeds original five columns');
  }
  if (strict) {
    for (const token of [...original, ...parts]) {
      assert.ok(!['<KANJI:00>', '<KANJI:25>'].includes(token),
        'KANJI operand is unsafe through the original formatter (NUL or percent)');
    }
  }
  const controls = tokens => tokens.filter(token => /^<(?:03:|04>|06:|09>|0D>|0E>|1B>|1D>)/.test(token));
  const formats = tokens => tokens.filter(token => token.startsWith('<FMT:'));
  assert.deepEqual(controls(parts), controls(original), 'Dialogue controls changed');
  assert.deepEqual(formats(parts), formats(original), 'Format placeholders changed');
  const glyphs = [...new Set(parts.filter(part => !part.startsWith('<') && part !== '\n' && part !== ' '))];
  const encoded = encodeDialogue(entry.translation, glyphs);
  let expandedBytes = encoded.length;
  let columns = 0;
  let line = 1;
  let stringIndex = 0;
  const stringArguments = parts.some(part => /^<FMT:%[0-9]*s>$/.test(part))
    ? boundedStringArguments(source, entry, characters, selected) : undefined;
  for (const part of parts) {
    if (part === '\n') { columns = 0; line++; continue; }
    if (part.startsWith('<FMT:')) {
      const width = Number(part.slice(6, -2) || 0);
      assert.ok(Number.isSafeInteger(width) && width <= 24, 'Format field width exceeds 24');
      if (part.endsWith('s>')) {
        const variants = stringArguments?.[stringIndex++];
        assert.ok(variants?.length, 'Unbounded %s expansion requires call-site evidence');
        columns += Math.max(...variants.map(value => value.columns + Math.max(0, width - value.measured)));
        expandedBytes += Math.max(...variants.map(value => value.bytes + Math.max(0, width - value.measured))) - (part.length - 6);
      } else {
        const maximum = stringArgumentEvidence.get(offset)?.decimalBytes ?? 9;
        const size = width ? Math.min(9, width) : maximum;
        columns += size;
        expandedBytes += size - (part.length - 6);
      }
    } else if (!part.startsWith('<') || part.startsWith('<KANJI:') ||
      ['<0D>', '<0E>', '<1B>', '<1D>'].includes(part)) columns++;
    assert.ok(columns <= 24, `Line ${line} exceeds 24 columns (${columns})`);
  }
  const capacity = stringArgumentEvidence.get(offset)?.capacity ?? 680;
  assert.ok(expandedBytes <= capacity, `Text buffer exceeds ${capacity} bytes (${expandedBytes})`);
  assert.ok(pointers.length > 0, 'No aligned source pointer references');
  assert.ok(!strict || Array.isArray(entry.pointerOffsets), 'Missing pointerOffsets evidence');
  if (entry.pointerOffsets !== undefined) {
    assert.ok(Array.isArray(entry.pointerOffsets) && entry.pointerOffsets.every(pointer =>
      Number.isInteger(pointer) && pointer >= 0 && pointer % 4 === 0 && pointer + 4 <= source.length),
    'Invalid pointer offsets');
    assert.equal(new Set(entry.pointerOffsets).size, entry.pointerOffsets.length, 'Duplicate pointer offsets');
    assert.deepEqual([...entry.pointerOffsets].sort((left, right) => left - right), pointers, 'Pointer inventory changed');
  }
  if (!pointerEvidence.pointerOffsets.length) {
    const error = new Error(`Non-text reference: all references to ${offset.toString(16)} belong to verified resources`);
    error.code = 'NON_TEXT_REFERENCE';
    error.pointerEvidence = pointerEvidence;
    throw error;
  }
  return { ...entry, offset: offset.toString(16), sourceHex: bytes.toString('hex'), ...pointerEvidence };
}

export function prepareFullDialogue(source, existing, shards, { requireComplete = false, candidates = [],
  characters = characterMap(source) } = {}) {
  const report = { status: 'partial-draft-not-full-game', shards: shards.map(shard => shard.name),
    entries: [], errors: [], blocked: [], filtered: [], duplicates: [], missing: [],
    scope: 'Heuristic text inventory 0x12fff4..0x1679ae; not all game text, graphics or battle pools' };
  const selected = new Map();
  const fail = (entry, message) => report.errors.push({ offset: entry?.offset, message });
  for (const entry of existing) {
    try {
      const offset = entryOffset(entry.offset);
      assert.ok(!selected.has(offset), 'Duplicate existing draft offset');
      selected.set(offset, { entry, strict: false, origin: 'existing' });
    } catch (error) { fail(entry, error.message); }
  }
  if (!shards.length) fail(undefined, 'No full-*.zh-Hant.json shards found');
  const sourceHash = createHash('sha256').update(source).digest('hex');
  for (const shard of shards) {
    if (!Array.isArray(shard.entries) || shard.language !== 'zh-Hant' ||
      (shard.sourceSha256 !== undefined && shard.sourceSha256 !== sourceHash)) {
      fail(undefined, `Invalid shard metadata: ${shard.name}`);
      continue;
    }
    for (const entry of shard.entries) {
      try {
        const offset = entryOffset(entry.offset);
        const previous = selected.get(offset);
        if (previous) {
          if (previous.origin !== 'existing') {
            assert.equal(entry.translation, previous.entry.translation, 'Conflicting shard translations');
            assert.equal(entry.status, previous.entry.status, 'Conflicting shard statuses');
          }
          const original = previous.entry.sourceHex ?? dialogueSource(source, offset).toString('hex');
          assert.equal(entry.sourceHex?.toLowerCase(), original.toLowerCase(), 'Duplicate source evidence differs');
          const pointers = [];
          for (let position = 0; position + 4 <= source.length; position += 4) {
            if (source.readUInt32LE(position) === offset + 0x08000000) pointers.push(position);
          }
          assert.ok(pointers.length, 'Duplicate has no source references');
          assert.deepEqual(entry.pointerOffsets, pointers, 'Duplicate pointer evidence differs');
          report.duplicates.push({ offset: offset.toString(16), ignoredShard: shard.name, retained: previous.origin });
          continue;
        }
        selected.set(offset, { entry, strict: true, origin: shard.name });
      } catch (error) { fail(entry, `${shard.name}: ${error.message}`); }
    }
  }
  const references = new Map([...selected.keys()].map(offset => [offset, []]));
  for (let position = 0; position + 4 <= source.length; position += 4) {
    references.get(source.readUInt32LE(position) - 0x08000000)?.push(position);
  }
  for (const { entry, strict, origin } of selected.values()) {
    if (strict && entry.status !== 'translated-draft') {
      report.blocked.push({ offset: entry.offset, status: entry.status, shard: origin,
        reason: entry.reason ?? entry.notes ?? 'Not marked translated-draft' });
      continue;
    }
    try {
      const validated = validateDialogueEntry(source, entry, characters, { strict, references, selected });
      if (strict) {
        const offset = entryOffset(entry.offset);
        const containers = candidates.filter(candidate => {
          const start = entryOffset(candidate.offset);
          const size = candidate.byteLength ?? (candidate.rawHex ?? candidate.sourceHex)?.length / 2;
          return candidate.pointerOffsets?.length && start < offset && start + size > offset;
        });
        for (const container of containers) {
          assert.notEqual(entry.sourceEncoding, 'shift_jis', 'Unreviewed overlapping Shift-JIS source');
          assert.notEqual(container.sourceEncoding, 'shift_jis', 'Unreviewed overlapping Shift-JIS source');
          const start = entryOffset(container.offset);
          const bytes = dialogueSource(source, start);
          const offsets = new Set();
          sourceTokens(bytes, characters, { offsets });
          assert.ok(offsets.has(offset - start), `Candidate begins inside source token at ${start.toString(16)}`);
          assert.equal(offset + validated.sourceHex.length / 2, start + bytes.length,
            `Suffix terminator differs from referenced source ${start.toString(16)}`);
        }
      }
      report.entries.push(validated);
      if (validated.rejectedPointerOffsets.length) report.filtered.push({ offset: validated.offset,
        status: 'translated-with-filtered-references', sourcePointerOffsets: validated.sourcePointerOffsets,
        pointerOffsets: validated.pointerOffsets, rejectedPointerOffsets: validated.rejectedPointerOffsets });
    }
    catch (error) {
      if (error.code === 'NON_TEXT_REFERENCE') report.blocked.push({ offset: entry.offset,
        status: 'non-text-reference-not-installed', shard: origin, reason: error.message, ...error.pointerEvidence });
      else fail(entry, `${origin}: ${error.message}`);
    }
  }
  const ranges = report.entries.map(entry => ({ entry, start: entryOffset(entry.offset),
    end: entryOffset(entry.offset) + entry.sourceHex.length / 2 + 1 })).sort((left, right) => left.start - right.start);
  for (let index = 0; index < ranges.length; index++) {
    const current = ranges[index];
    for (let next = index + 1; next < ranges.length && ranges[next].start < current.end; next++) {
      const suffix = ranges[next];
      if (current.entry.sourceEncoding === 'shift_jis' || suffix.entry.sourceEncoding === 'shift_jis') {
        fail(suffix.entry, `Unreviewed overlapping Shift-JIS source at ${current.entry.offset}`);
        continue;
      }
      const offsets = new Set();
      sourceTokens(Buffer.from(current.entry.sourceHex, 'hex'), characters, { offsets });
      if (suffix.end !== current.end || !offsets.has(suffix.start - current.start)) {
        fail(suffix.entry, `Overlapping source is not a token-aligned suffix of ${current.entry.offset}`);
      }
    }
    for (const pointer of current.entry.pointerOffsets) {
      const owner = ranges.find(range => pointer < range.end && pointer + 4 > range.start);
      if (owner) fail(current.entry, `Pointer ${pointer.toString(16)} overlaps source text ${owner.entry.offset}`);
    }
  }
  const accepted = new Set(report.entries.map(entry => entryOffset(entry.offset)));
  report.missing = candidates.filter(entry => !accepted.has(entryOffset(entry.offset))).map(entry => entry.offset);
  if (requireComplete && (report.blocked.length || report.missing.length)) {
    fail(undefined, `Incomplete candidate inventory: ${report.blocked.length} blocked, ${report.missing.length} missing`);
  }
  report.candidateInventoryComplete = candidates.length > 0 && !report.errors.length && !report.missing.length && !report.blocked.length;
  return report;
}

export function createDialogueAllocator(source, base, start, { full = false } = {}) {
  assert.equal(base.length, source.length, 'Base ROM length changed');
  let paddingStart = source.length;
  while (paddingStart && source[paddingStart - 1] === 0xff) paddingStart--;
  assert.ok(Number.isInteger(start) && start >= paddingStart && start <= source.length, 'Allocation must start in original padding');
  if (full) assert.equal(source.length, 0x400000, 'Full mode requires original 4MB ROM');
  const output = Buffer.alloc(full ? 0x800000 : source.length, 0xff);
  base.copy(output);
  let cursor = start;
  let dataCursor = source.length;
  const allocations = [];
  const nextOffset = (code = false) => ((full && !code ? dataCursor : cursor) + 3) & ~3;
  const allocate = (bytes, label, code = false) => {
    const offset = nextOffset(code);
    const limit = full && code ? source.length : output.length;
    assert.ok(bytes.length > 0 && offset + bytes.length <= limit, `Insufficient ${code ? 'original code padding' : 'ROM space'} for ${label}`);
    assert.ok(output.subarray(offset, offset + bytes.length).every(byte => byte === 0xff), `Allocation overlaps used bytes: ${label}`);
    bytes.copy(output, offset);
    if (full && !code) dataCursor = offset + bytes.length;
    else cursor = offset + bytes.length;
    allocations.push({ label, offset, size: bytes.length });
    return offset;
  };
  return { output, allocations, allocate, nextOffset };
}

export function dialogueArguments(argumentsList) {
  const supported = new Set(['--full', '--check', '--require-complete', '--large-text']);
  for (const argument of argumentsList) {
    assert.ok(!argument.startsWith('--') || supported.has(argument), `Unknown option: ${argument}`);
  }
  assert.ok(!argumentsList.includes('--large-text'), 'Silver large-text mode is retired; build without --large-text for original 8x8 layout');
  const paths = argumentsList.filter(argument => !argument.startsWith('--'));
  assert.ok(paths.length <= 1, 'Expected at most one source ROM path');
  const full = argumentsList.includes('--full');
  const check = argumentsList.includes('--check');
  const requireComplete = argumentsList.includes('--require-complete');
  assert.ok(full || (!check && !requireComplete), '--check and --require-complete require --full');
  return { full, check, requireComplete, sourcePath: paths[0] };
}

export function assertPreservedRom(source, output, { allocations, pointers, hooks = [] }) {
  assert.ok(output.length >= source.length, 'Output truncates original ROM');
  if (source.length === 0x400000) {
    for (const span of changedResourceSpans(source, output)) {
      const offset = source.subarray(span.header, span.end).findIndex((byte, index) => byte !== output[span.header + index]);
      assert.fail(`Non-text resource changed at ${(span.header + offset).toString(16)} (${span.kind} ${span.header.toString(16)})`);
    }
  }
  const permitted = Buffer.alloc(source.length);
  for (const { offset, size } of allocations) {
    assert.ok(Number.isInteger(offset) && Number.isInteger(size) && offset >= 0 && size > 0 &&
      offset + size <= output.length, 'Invalid allocation range');
    if (offset < source.length) {
      assert.ok(source.subarray(offset, Math.min(offset + size, source.length)).every(byte => byte === 0xff),
        'Allocation overwrites original non-padding bytes');
      permitted.fill(1, offset, Math.min(offset + size, source.length));
    }
  }
  for (const offset of [...pointers, ...hooks.map(hook => hook.offset)]) {
    assert.ok(Number.isInteger(offset) && offset >= 0xc0 && offset + 4 <= source.length, 'Invalid approved patch offset');
    permitted.fill(1, offset, offset + 4);
  }
  for (let offset = 0; offset < source.length; offset++) {
    assert.ok(source[offset] === output[offset] || permitted[offset], `Unapproved ROM change at ${offset.toString(16)}`);
  }
}

export function translationParts(text) {
  const parts = text.match(/<KANJI:[0-9A-F]{2}>|<03:[0-9A-F]{2}>|<06:[0-9A-F]{2}>|<FMT:%[0-9]*[sd]>|<[0-9A-F]{2}>|[^<>]/gu) ?? [];
  assert.equal(parts.join(''), text, 'Malformed translation control token');
  return parts;
}

export function encodeDialogue(text, characters) {
  const codes = new Map(characters.map((character, index) => [character, index]));
  const bytes = [];
  for (const part of translationParts(text)) {
    if (part.startsWith('<KANJI:')) bytes.push(5, Number.parseInt(part.slice(7, 9), 16));
    else if (part.startsWith('<03:')) {
      assert.equal(part, '<03:15>', 'Unreviewed text color');
      bytes.push(3, 0x15);
    }
    else if (part.startsWith('<06:')) bytes.push(6, Number.parseInt(part.slice(4, 6), 16));
    else if (part.startsWith('<FMT:')) bytes.push(...Buffer.from(part.slice(5, -1), 'ascii'));
    else if (part.startsWith('<')) {
      const code = Number.parseInt(part.slice(1, 3), 16);
      assert.ok([4, 9, 13, 14, 0x1b, 0x1d].includes(code), `Unreviewed dialogue control ${part}`);
      bytes.push(code);
    } else if (part === '\n') bytes.push(10);
    else if (part === ' ') bytes.push(32);
    else {
      const glyph = codes.get(part);
      assert.ok(glyph !== undefined && glyph < 4096, `Unmapped glyph ${part}`);
      bytes.push(2, 0x40 + (glyph >> 6), 0x40 + (glyph & 63));
    }
  }
  bytes.push(0);
  return Buffer.from(bytes);
}

export function encodeLargeDialogue(pages, glyphTiles, { portrait, columns = 9 } = {}) {
  assert.ok(pages.length > 0 && Number.isInteger(columns) && columns > 0 && columns <= 12);
  assert.ok(portrait === undefined || (Number.isInteger(portrait) && portrait >= 0 && portrait <= 255));
  const bytes = [9];
  if (portrait !== undefined) bytes.push(6, portrait);
  for (const [pageIndex, lines] of pages.entries()) {
    assert.equal(lines.length, 1, 'Large dialogue requires one line per page in the current window');
    const used = new Set();
    for (const [lineIndex, line] of lines.entries()) {
      const characters = [...line];
      assert.ok(characters.length > 0 && characters.length <= columns, 'Large dialogue line exceeds width');
      if (lineIndex) bytes.push(10);
      for (let row = 0; row < 2; row++) {
        if (row) bytes.push(10);
        for (const character of characters) {
          const tiles = glyphTiles.get(character);
          assert.ok(tiles?.length === 4, `Missing large glyph: ${character}`);
          for (const tile of tiles.slice(row * 2, row * 2 + 2)) {
            assert.ok(Number.isInteger(tile) && tile >= 0 && tile < 4096, 'Invalid large tile ID');
            used.add(tile);
            bytes.push(2, 0x40 + (tile >> 6), 0x40 + (tile & 63));
          }
        }
      }
    }
    assert.ok(used.size <= 56, 'Large dialogue exceeds cache budget (8 slots reserved)');
    bytes.push(9);
    if (pageIndex < pages.length - 1) bytes.push(10, 10);
  }
  bytes.push(0);
  assert.ok(bytes.length <= 680, 'Large dialogue exceeds text buffer');
  return Buffer.from(bytes);
}

export function thumbCall(offset, target) {
  const displacement = target - offset - 4;
  assert.ok(displacement % 2 === 0 && displacement >= -0x400000 && displacement < 0x400000);
  const bytes = Buffer.alloc(4);
  bytes.writeUInt16LE(0xf000 | ((displacement >> 12) & 0x7ff));
  bytes.writeUInt16LE(0xf800 | ((displacement >> 1) & 0x7ff), 2);
  return bytes;
}

export function encodeLargeLabel(text, glyphTiles) {
  const dialogue = encodeLargeDialogue([[text]], glyphTiles);
  return Buffer.concat([dialogue.subarray(1, -2), Buffer.from([0])]);
}

export function encodeBattleResult({ subject, message }, glyphTiles) {
  const name = subject === '%s' ? Buffer.from('%s', 'ascii') : encodeLargeLabel(subject, glyphTiles).subarray(0, -1);
  const label = encodeLargeLabel(message, glyphTiles).subarray(0, -1);
  const encoded = Buffer.concat([Buffer.from([9]), name, Buffer.from([9, 10, 10]),
    label, Buffer.from('\n%d', 'ascii'), Buffer.from([9, 0])]);
  const expandedNameSize = 3 * 12 + 1;
  assert.ok(encoded.length + (subject === '%s' ? expandedNameSize - 2 : 0) + 9 <= 680,
    'Battle result exceeds expanded text buffer');
  return encoded;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { full, check, requireComplete, sourcePath } = dialogueArguments(process.argv.slice(2));
  const largeText = false;
  const source = readRom(sourcePath);
  inspectRom(source);
  let fullReport;
  if (full) {
    const existing = ['menus', 'battle', 'overworld'].flatMap(name =>
      JSON.parse(readFileSync(`translations/${name}.zh-Hant.json`, 'utf8')).entries);
    fullReport = prepareFullDialogue(source, existing, readFullShards(), {
      requireComplete, candidates: extractCandidates(source).entries,
    });
    const summary = { ...fullReport, entries: fullReport.entries.length };
    if (check) {
      await new Promise((resolve, reject) => process.stdout.write(JSON.stringify(summary, null, 2) + '\n',
        error => error ? reject(error) : resolve()));
      process.exit(fullReport.errors.length ? 1 : 0);
    }
    assert.equal(fullReport.errors.length, 0, `Full-corpus preflight failed:\n${JSON.stringify(summary, null, 2)}`);
    console.log(`Full mode: ${fullReport.entries.length} entries; ${fullReport.blocked.length} blocked; ` +
      `${fullReport.missing.length} missing candidates. Partial draft, not a complete game localization.`);
  }
  execFileSync('node', ['tools/build-prototype.mjs', ...(sourcePath ? [sourcePath] : [])], { stdio: 'inherit' });
  const basePrefix = 'build/momotarou-zh-Hant-menu-prototype';
  const base = JSON.parse(readFileSync(`${basePrefix}.json`));
  const baseOutput = readFileSync(`${basePrefix}.gba`);
  assert.equal(createHash('sha256').update(baseOutput).digest('hex'), base.outputSha256);
  const { output, allocations, allocate, nextOffset } = createDialogueAllocator(source, baseOutput,
    Math.max(...base.allocations.map(entry => entry.offset + entry.size)), { full });
  const battle = JSON.parse(readFileSync('translations/battle.zh-Hant.json'));
  const overworld = JSON.parse(readFileSync('translations/overworld.zh-Hant.json'));
  const startup = base.translated.slice(0, 3).map(entry => ({
    offset: entry.offset,
    sourceHex: dialogueSource(source, Number.parseInt(entry.offset, 16)).toString('hex'),
    translation: entry.translation,
    pointerOffsets: entry.pointerOffsets,
  }));
  const entries = fullReport?.entries ?? [...startup, ...battle.entries, ...overworld.entries];
  const readable = JSON.parse(readFileSync('translations/readable-ui.zh-Hant.json'));
  if (largeText) {
    for (const entry of readable.battleStatus) {
      assert.ok([...entry.translation].length <= 3, 'Battle result subject exceeds three native characters');
      entries.push({ ...entry, scopedPointers: true });
    }
  }
  const characters = [...new Set(entries.flatMap(entry => translationParts(entry.translation))
    .filter(part => !part.startsWith('<') && part !== '\n' && part !== ' '))];
  assert.ok(characters.length <= 4096);
  writeFileSync('build/dialogue-characters.json', JSON.stringify(characters));
  execFileSync('build/rasterize-font', ['build/dialogue-characters.json', 'build/dialogue-tiles.bin',
    translationFont.path, String(translationFont.pointSize)], { stdio: 'inherit' });
  let tiles = readFileSync('build/dialogue-tiles.bin');
  validateGlyphTiles(characters, tiles);
  const largePages = [['什麼也沒找到。']];
  const probePages = [...largePages, ['再找找看吧！']];
  const largeLabels = new Map(Object.entries(readable.labels));
  if (largeText) for (const entry of readable.battleStatus) largeLabels.set(entry.offset, entry.translation);
  const largeDialogues = new Map(Object.entries(readable.dialogues));
  const battleResults = new Map(Object.entries(readable.battleResults));
  if (largeText) {
    const knownOffsets = new Set(entries.map(entry => entry.offset));
    for (const offset of [...largeLabels.keys(), ...largeDialogues.keys(), ...battleResults.keys()]) {
      assert.ok(knownOffsets.has(offset), `Unknown native UI source: ${offset}`);
      assert.equal([largeLabels, largeDialogues, battleResults].filter(layout => layout.has(offset)).length, 1,
        `Duplicate native UI layout: ${offset}`);
    }
  }
  const largeGlyphTiles = new Map();
  let largeCharacters = [];
  if (largeText) {
    for (const entry of base.translated) {
      for (const pointer of entry.pointerOffsets) output.writeUInt32LE(source.readUInt32LE(pointer), pointer);
    }
    output.writeUInt32LE(source.readUInt32LE(0x46a7c), 0x46a7c);
    largeCharacters = [...new Set(probePages.flat().join('') + [...largeLabels.values()].join('') +
      [...largeDialogues.values()].flat(2).join('') + [...battleResults.values()]
        .map(({ subject, message }) => (subject === '%s' ? '' : subject) + message).join(''))];
    writeFileSync('build/large-characters.json', JSON.stringify(largeCharacters));
    execFileSync('build/rasterize-font', ['build/large-characters.json', 'build/large-tiles.bin',
      translationFont.path, '19', '16'], { stdio: 'inherit' });
    const largeTiles = readFileSync('build/large-tiles.bin');
    assert.equal(largeTiles.length, largeCharacters.length * 128);
    const library = [];
    const tileIds = new Map(library.map((tile, index) => [tile.toString('hex'), index]));
    for (const [index, character] of largeCharacters.entries()) {
      const quadrants = [];
      for (let quadrant = 0; quadrant < 4; quadrant++) {
        const tile = largeTiles.subarray(index * 128 + quadrant * 32, index * 128 + (quadrant + 1) * 32);
        const key = tile.toString('hex');
        if (!tileIds.has(key)) {
          tileIds.set(key, library.length);
          library.push(tile);
        }
        quadrants.push(tileIds.get(key));
      }
      largeGlyphTiles.set(character, quadrants);
    }
    tiles = Buffer.concat(library);
    assert.ok(tiles.length / 32 <= 4096);
  }
  const count = Buffer.alloc(4);
  count.writeUInt32LE(tiles.length / 32);
  const countOffset = allocate(count, 'dynamic-glyph-count');
  const tilesOffset = allocate(tiles, 'dynamic-glyph-library');
  const codeOffset = nextOffset(true);
  execFileSync('arm-none-eabi-gcc', ['-mcpu=arm7tdmi', '-mthumb', '-Os', '-ffreestanding', '-fno-builtin',
    ...(largeText ? ['-DGLYPH_SLOTS=128'] : []),
    '-Wall', '-Wextra', '-Werror', '-c', 'tools/glyph-loader.c', '-o', 'build/glyph-loader.o'], { stdio: 'inherit' });
  execFileSync('arm-none-eabi-as', ['-mcpu=arm7tdmi', '-mthumb', ...(largeText ? ['--defsym', 'LARGE_UI=1'] : []),
    'tools/glyph-hooks.s', '-o', 'build/glyph-hooks.o'], { stdio: 'inherit' });
  execFileSync('arm-none-eabi-ld', ['-Ttext', `0x${(0x08000000 + codeOffset).toString(16)}`, '-e', 'menu_glyph_hook',
    '--defsym', `chinese_glyphs=0x${(0x08000000 + tilesOffset).toString(16)}`,
    '--defsym', `chinese_glyph_count=0x${(0x08000000 + countOffset).toString(16)}`,
    'build/glyph-hooks.o', 'build/glyph-loader.o', '-o', 'build/glyph-loader.elf'], { stdio: 'inherit' });
  execFileSync('arm-none-eabi-objcopy', ['-O', 'binary', '-j', '.text', 'build/glyph-loader.elf', 'build/glyph-loader.bin']);
  const symbols = new Map(execFileSync('arm-none-eabi-nm', ['--defined-only', 'build/glyph-loader.elf'], { encoding: 'utf8' })
    .trim().split('\n').map(line => { const fields = line.trim().split(/\s+/); return [fields[2], Number.parseInt(fields[0], 16)]; }));
  assert.equal(allocate(readFileSync('build/glyph-loader.bin'), 'dynamic-glyph-code', true), codeOffset);
  const hooks = [];
  for (const [offset, symbol] of [[0x3d418, 'menu_glyph_hook'], [0x3d2ac, 'sjis_glyph_hook']]) {
    assert.equal(source.subarray(offset, offset + 4).toString('hex'), '43469918');
    const target = symbols.get(symbol) - 0x08000000;
    thumbCall(offset, target).copy(output, offset);
    hooks.push({ offset, target, symbol });
  }
  const layoutPatches = [];
  if (largeText) {
    for (const [offset, originalTarget, symbol] of [
      [0x4526c, 0x3d488, 'native_label_hook'], [0x41e88, 0x3d488, 'native_label_hook'],
      [0x45296, 0x46ddc, 'native_cursor_hook'], [0x41ea8, 0x46ddc, 'native_cursor_hook'],
      [0x41f0a, 0x46ddc, 'native_cursor_hook'], [0x45016, 0x6810, 'native_start_window'],
      [0x41f44, 0x3d488, 'native_label_hook'], [0x420a6, 0x3d488, 'native_label_hook'],
      [0x41f64, 0x46ddc, 'native_cursor_hook'], [0x41fdc, 0x46ddc, 'native_cursor_hook'],
      [0x420c6, 0x46ddc, 'native_cursor_hook'], [0x4214c, 0x46ddc, 'native_cursor_hook'],
      [0x42088, 0x46a9c, 'native_item_window'],
      [0x421e8, 0x3d488, 'native_label_hook'], [0x42208, 0x46ddc, 'native_cursor_hook'],
      [0x421d4, 0x46a9c, 'native_target_window'],
    ]) {
      assert.deepEqual(source.subarray(offset, offset + 4), thumbCall(offset, originalTarget));
      const target = symbols.get(symbol) - 0x08000000;
      thumbCall(offset, target).copy(output, offset);
      hooks.push({ offset, target, symbol });
    }
    for (const [offset, oldValue, newValue] of [
      [0x41e72, 0x2306, 0x230a], [0x41f2e, 0x2305, 0x2308],
      [0x41d4c, 0x2207, 0x2208], [0x41d4e, 0x2305, 0x2306],
      [0x41e0c, 0x2202, 0x2203], [0x41e1c, 0x2203, 0x2204],
      [0x41e6e, 0x2104, 0x2105], [0x41f2a, 0x2104, 0x2105], [0x42084, 0x2104, 0x2105],
    ]) {
      assert.equal(source.readUInt16LE(offset), oldValue);
      output.writeUInt16LE(newValue, offset);
      layoutPatches.push({ offset, sourceHex: source.subarray(offset, offset + 2).toString('hex'),
        targetHex: output.subarray(offset, offset + 2).toString('hex') });
    }
  }
  const translated = [];
  const sourceCharacters = characterMap(source);
  for (const entry of entries) {
    if (largeText && !largeLabels.has(entry.offset) && !largeDialogues.has(entry.offset) && !battleResults.has(entry.offset)) continue;
    const offset = Number.parseInt(entry.offset, 16);
    const bytes = full ? Buffer.from(entry.sourceHex, 'hex') : dialogueSource(source, offset);
    if (entry.sourceHex) assert.equal(bytes.toString('hex'), entry.sourceHex);
    else assert.equal(decodeText(bytes, sourceCharacters), entry.source, entry.offset);
    assert.deepEqual(source.subarray(offset, offset + bytes.length), bytes);
    assert.equal(source[offset + bytes.length], 0);
    const encoded = largeText && battleResults.has(entry.offset)
      ? encodeBattleResult(battleResults.get(entry.offset), largeGlyphTiles)
      : largeText && largeDialogues.has(entry.offset)
      ? encodeLargeDialogue(largeDialogues.get(entry.offset), largeGlyphTiles)
      : largeText && largeLabels.has(entry.offset)
      ? encodeLargeLabel(largeLabels.get(entry.offset), largeGlyphTiles)
      : encodeDialogue(entry.translation, characters);
    validateDialogueEncoding(bytes, entry, encoded, sourceCharacters);
    const target = allocate(encoded, entry.offset);
        const originalPointers = [];
    for (let position = 0; position + 4 <= source.length; position += 4) {
        if (source.readUInt32LE(position) === offset + 0x08000000 &&
          (!entry.scopedPointers || entry.pointerOffsets.includes(position))) originalPointers.push(position);
    }
        const evidence = filterTextPointers(source, originalPointers);
        const pointers = evidence.pointerOffsets;
    assert.ok(pointers.length > 0, `No references to ${entry.offset}`);
        if (entry.pointerOffsets) assert.deepEqual(originalPointers, entry.sourcePointerOffsets ?? entry.pointerOffsets);
        if (full) assert.deepEqual(pointers, entry.pointerOffsets);
    for (const pointer of pointers) output.writeUInt32LE(target + 0x08000000, pointer);
        translated.push({ ...entry, sourceHex: bytes.toString('hex'), targetOffset: target, ...evidence,
      ...(largeText && largeLabels.has(entry.offset) ? { layout: '16x16-label', translation: largeLabels.get(entry.offset) } : {}),
      ...(largeText && largeDialogues.has(entry.offset) ? { layout: '16x16-quadrants', pages: largeDialogues.get(entry.offset),
        translation: largeDialogues.get(entry.offset).flat().join('\n') } : {}),
      ...(largeText && battleResults.has(entry.offset) ? { layout: 'battle-result', result: battleResults.get(entry.offset),
        translation: `${battleResults.get(entry.offset).subject}\n${battleResults.get(entry.offset).message}\n%d` } : {}) });
  }
  if (largeText) {
    for (const [offset, pointer, expected, text] of [
      [0x1680a0, 0x41e40, '05b520253364', 'HP%3d'],
      [0x1680a7, 0x41e44, '05b120253364', 'MP%3d'],
    ]) {
      assert.equal(dialogueSource(source, offset).toString('hex'), expected);
      assert.equal(source.readUInt32LE(pointer), 0x08000000 + offset);
      const targetOffset = allocate(Buffer.from(text + '\0', 'ascii'), 'battle-status-format');
      output.writeUInt32LE(0x08000000 + targetOffset, pointer);
      translated.push({ offset: offset.toString(16), sourceHex: expected, translation: text,
        targetOffset, pointerOffsets: [pointer], layout: 'ascii-format' });
    }
  }
  const largeMetadata = largeText ? {
    status: 'native-ui-partial-translation', cellSize: 16, pointSize: 19,
    characters: largeCharacters, glyphTiles: Object.fromEntries(largeGlyphTiles),
    columns: 9, maxLinesPerPage: 1, cacheTileBudget: 56,
    labels: Object.fromEntries(largeLabels),
    probe: { targetOffset: allocate(encodeLargeDialogue(probePages, largeGlyphTiles, { portrait: 0 }),
      'unreferenced-portrait-paging-probe'), pages: probePages, portrait: 0 },
  } : undefined;
  assertPreservedRom(source, output, {
    allocations: [...base.allocations, ...allocations], hooks,
    pointers: [0x46a7c, ...base.translated.flatMap(entry => entry.pointerOffsets),
      ...translated.flatMap(entry => entry.pointerOffsets)],
  });
  for (const entry of translated) {
    const offset = entryOffset(entry.offset);
    assert.deepEqual(output.subarray(offset, offset + entry.sourceHex.length / 2 + 1),
      source.subarray(offset, offset + entry.sourceHex.length / 2 + 1), `Original text changed at ${entry.offset}`);
  }
  const patch = makeIps(source, output);
  assert.deepEqual(applyPrototypeIps(source, patch), output);
  const prefix = 'build/momotarou-zh-Hant';
  writeFileSync(`${prefix}.gba`, output);
  writeFileSync(`${prefix}.ips`, patch);
  writeFileSync(`${prefix}-font-licenses.txt`, readFileSync(`${basePrefix}-font-licenses.txt`, 'utf8') +
    (largeText ? '\nNative UI build: displayed Chinese uses 19pt Silver at integer pixel positions,\nwithout antialiasing, in 16x16 cells split into four 8x8 tiles. Unconverted text\nuses the original Japanese font. Reduced Silver assets from the base build\nremain in unused ROM padding but are not loaded or referenced by this build.\n' : ''));
  writeFileSync(`${prefix}.json`, JSON.stringify({
    status: full ? 'partial-full-corpus-draft-not-full-game' : 'experimental-dynamic-glyphs-not-full-translation', sourceSha256: base.sourceSha256,
    outputSha256: createHash('sha256').update(output).digest('hex'),
    baseTranslationCount: full || largeText ? 0 : base.translated.length, dynamicGlyphCount: tiles.length / 32,
    ...(full ? { fullCorpus: { ...fullReport, entries: fullReport.entries.length },
      sourceSize: source.length, outputSize: output.length, baseAllocations: base.allocations } : {}),
    font: base.font,
    ...(largeText ? { largeText: largeMetadata, layoutPatches } : {}),
    cacheSlots: largeText ? 128 : 64, tilesOffset, codeOffset, hooks, allocations, translated,
  }, null, 2) + '\n');
  console.log(`Built dynamic-glyph experiment: ${prefix}.gba`);
}