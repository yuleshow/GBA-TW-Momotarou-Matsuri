import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { DEFAULT_SOURCE, SOURCE_SHA256, inspectRom, readRom } from './inspect-rom.mjs';
import { characterMap, decodeText, extractCandidates, findTextEnd } from './extract-text.mjs';
import { decodePairs, encodeLiteralPairs, validateGlyphTiles } from './font.mjs';
import { applyPrototypeIps, buildPrototype, makeIps } from './build-prototype.mjs';
import { changedResourceSpans, filterTextPointers, inspectTextPointerResources } from './audit-text-pointers.mjs';
import { assertPreservedRom, boundedStringArguments, dialogueArguments, createDialogueAllocator, prepareFullDialogue, readFullShards, sourceTokens, validateDialogueEntry, validateDialogueEncoding,
  dialogueSource, encodeDialogue, encodeLargeDialogue, encodeLargeLabel, encodeBattleResult, thumbCall, translationParts } from './build-dialogue.mjs';

const rom = readRom();
const characters = characterMap(rom);

test('native numeric resources own E800 as well as E000; neither is a free Chinese cache bank', () => {
  const { decodeResource } = inspectTextPointerResources(rom);
  assert.equal(rom.readUInt32LE(0x1a8a4), 0x08254fa4);
  assert.deepEqual(rom.subarray(0x1a830, 0x1a834), thumbCall(0x1a830, 0x46ef8));
  assert.equal(rom.readUInt32LE(0x46f2c), 0x0600e000);
  assert.deepEqual(rom.subarray(0x46efe, 0x46f02), thumbCall(0x46efe, 0xc894));
  const timing = decodeResource(rom, 0x254fa4).data;
  assert.equal(timing.length, 0xde0);
  assert.equal(0xe000 + timing.length, 0xede0);
  for (const tile of [0x100, 0x108, 0x120, 0x128, 0x140, 0x148, 0x160, 0x168]) {
    const bitmap = timing.subarray((tile - 0x100) * 32, (tile - 0x100 + 1) * 32);
    assert.equal(bitmap.length, 32);
    assert.ok(new Set(bitmap).size > 1, `Native numeric tile ${tile.toString(16)} is not padding`);
  }
  for (const [call, pointer, resource] of [[0x31c96, 0x31ca0, 0x2cb834], [0x3e2f4, 0x3e348, 0x227eb8]]) {
    assert.deepEqual(rom.subarray(call, call + 4), thumbCall(call, 0x46ef8));
    assert.equal(rom.readUInt32LE(pointer), 0x08000000 + resource);
    assert.ok(decodeResource(rom, resource).data.length > 0x800);
  }
  assert.equal(rom.readUInt32LE(0x3e350), 0x0600eac0);
  assert.equal(rom.readUInt32LE(0x3e354), 0x0600eec0);
  assert.equal(rom.readUInt16LE(0x3e31a), 0x490d);
  assert.equal(rom.readUInt16LE(0x3e328), 0x490a);
  for (const call of [0x3e320, 0x3e32c]) {
    assert.equal(rom.readUInt16LE(call - 2), 0x2260);
    assert.deepEqual(rom.subarray(call, call + 4), thumbCall(call, 0x470ac));
  }
  assert.equal(decodePairs(rom, 0x2f8ecc).data.length, 0x2000);
  assert.equal(decodePairs(rom, 0x2f9878).data.length, 0x720);
  assert.ok((0xf000 - 0xede0) + (0xf800 - 0xf720) < 64 * 32);
});

test('compressed resource address coincidences are never installed as text pointers', () => {
  const entry = { offset: '14aaab', sourceHex: 'b82dd91d09', pointerOffsets: [0x3ce044],
    translation: '甲<1D><09>', status: 'translated-draft' };
  assert.equal(rom.readUInt32LE(0x3ce044), 0x0814aaab);
  assert.throws(() => validateDialogueEntry(rom, entry, characters, { strict: true }), /Non-text reference/);
  const report = prepareFullDialogue(rom, [], [{ name: 'full-resource-test.zh-Hant.json',
    language: 'zh-Hant', entries: [entry] }]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.entries, []);
  assert.equal(report.blocked.length, 1);
  assert.equal(report.blocked[0].offset, entry.offset);
  assert.equal(report.blocked[0].status, 'non-text-reference-not-installed');
  const output = Buffer.from(rom);
  output.writeUInt32LE(0x0843b8d0, 0x3ce044);
  assert.throws(() => assertPreservedRom(rom, output, { allocations: [], pointers: [0x3ce044] }),
    /Non-text resource changed at 3ce044/);
  const changed = Buffer.from(rom);
  changed[0] ^= 1;
  assert.throws(() => validateDialogueEntry(changed, entry, characters), /requires verified ROM/);
});

test('mixed PCM and real text references retain 131208 and require all original evidence', () => {
  const entry = readFullShards().flatMap(shard => shard.entries).find(entry => entry.offset === '131208');
  assert.ok(entry);
  const validated = validateDialogueEntry(rom, entry, characters, { strict: true });
  assert.deepEqual(validated.sourcePointerOffsets, [0x100894, 0x131fa0]);
  assert.deepEqual(validated.pointerOffsets, [0x131fa0]);
  assert.deepEqual(validated.rejectedPointerOffsets, [0x100894]);
  assert.throws(() => validateDialogueEntry(rom, { ...entry, pointerOffsets: [0x131fa0] }, characters,
    { strict: true }), /Pointer inventory changed/);
  const report = prepareFullDialogue(rom, [], [{ name: 'full-mixed-test.zh-Hant.json', language: 'zh-Hant', entries: [entry] }]);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.blocked, []);
  assert.equal(report.entries.length, 1);
  assert.equal(report.filtered[0].status, 'translated-with-filtered-references');
  assert.deepEqual(report.filtered[0].pointerOffsets, [0x131fa0]);
});

test('resource ownership excludes all 24 new false matches without losing valid entries', () => {
  const existing = ['menus', 'battle', 'overworld'].flatMap(name =>
    JSON.parse(readFileSync(`translations/${name}.zh-Hant.json`)).entries);
  const report = prepareFullDialogue(rom, existing, readFullShards());
  assert.deepEqual(report.errors, []);
  const excluded = report.blocked.filter(entry => entry.status === 'non-text-reference-not-installed');
  assert.equal(excluded.length, 24);
  assert.equal(report.entries.length, 2300);
  assert.equal(report.filtered.length, 1);
  const rejected = [...excluded, ...report.filtered].flatMap(entry => entry.rejectedPointerOffsets);
  assert.equal(rejected.length, 25);
  const resources = inspectTextPointerResources(rom);
  assert.equal(rejected.filter(pointer => resources.containers(pointer).some(span => span.kind === 'pcm')).length, 16);
  assert.equal(rejected.filter(pointer => resources.containers(pointer).some(span => span.kind !== 'pcm')).length, 9);
  for (const entry of excluded) {
    const original = [...existing, ...readFullShards().flatMap(shard => shard.entries)].find(candidate => candidate.offset === entry.offset);
    assert.throws(() => validateDialogueEntry(rom, original, characters), /Non-text reference/);
    assert.throws(() => validateDialogueEntry(rom, { ...original, sourceHex: 'ff' }, characters), /Source bytes changed/);
    assert.throws(() => validateDialogueEntry(rom, { ...original, pointerOffsets: [] }, characters), /Pointer inventory changed/);
  }
});

test('whole compressed and PCM resources cannot be changed even by approved pointers or hooks', () => {
  const resources = inspectTextPointerResources(rom);
  assert.equal(resources.pairResources, 1013);
  assert.equal(resources.directPcmSamples, 44);
  assert.equal(changedResourceSpans(rom, rom).length, 0);
  const output = Buffer.from(rom);
  for (const pointer of [0x100894, 0x209170, 0x3ce044, 0xfd390, 0x208d50, 0x10861f]) {
    output[pointer] ^= 1;
    assert.throws(() => assertPreservedRom(rom, output, { allocations: [], pointers: [pointer] }), /Non-text resource changed/);
    assert.throws(() => assertPreservedRom(rom, output, { allocations: [], pointers: [], hooks: [{ offset: pointer }] }), /Non-text resource changed/);
    assert.ok(changedResourceSpans(rom, output).length);
    output[pointer] ^= 1;
  }
  assert.deepEqual(filterTextPointers(rom, [0x10861c, 0x131fa0]).pointerOffsets, [0x131fa0]);
  output.writeUInt32LE(0x08400000, 0x131fa0);
  assert.doesNotThrow(() => assertPreservedRom(rom, output, { allocations: [], pointers: [0x131fa0] }));
});

test('full shards load in filename order without including legacy or unfinished nonmatching files', () => {
  const directory = mkdtempSync(join(tmpdir(), 'momotarou-full-shards-'));
  try {
    for (const name of ['full-08.zh-Hant.json', 'full-01.zh-Hant.json', 'menus.zh-Hant.json', 'full-02.zh-Hant.json.tmp']) {
      writeFileSync(join(directory, name), JSON.stringify({ name: 'untrusted name', language: 'zh-Hant', entries: [] }));
    }
    assert.deepEqual(readFullShards(directory).map(shard => shard.name), ['full-01.zh-Hant.json', 'full-08.zh-Hant.json']);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('ROM instructions ground color operands and the limited formatter whitelist', () => {
  assert.equal(rom.readUInt16LE(0x3d3cc), 0x7848);
  assert.equal(rom.readUInt16LE(0x3d3ce), 0x3810);
  assert.equal(rom.readUInt32LE(0x3d3e0), 0x081679ae);
  assert.equal(rom.readUInt32LE(0x3d3dc), 0x050001c4);
  assert.equal(rom.readUInt16LE(0x3d5d8), 0x2825);
  assert.equal(rom.readUInt16LE(0x3d5e2), 0x2906);
  assert.equal(rom.readUInt16LE(0x3d68a), 0x2900);
  assert.equal(rom.readUInt16LE(0x3d6e0), 0x2608);
  assert.equal(rom.subarray(0x3d708, 0x3d70e).toString('hex'), '1016404510da');
  assert.equal(rom.readUInt16LE(0x3da60), 0x2905);
  assert.equal(rom.readUInt32LE(0xbf6c), 0x0813594c);
  assert.equal(rom.readUInt32LE(0x27f4), 0x0813594c);
  assert.equal(rom.readUInt32LE(0x2830), 0x0814242c);
  assert.equal(rom.readUInt32LE(0xb4a4), 0x08133fac);
  assert.equal(rom.readUInt32LE(0xb4a8), 0x08167d80);
  assert.equal(rom.readUInt32LE(0xbb70), 0x0813594c);
  assert.equal(rom.readUInt32LE(0x3e040), 0x08167d80);
  assert.equal(rom.readUInt32LE(0x3e0a8), 0x08167d80);
  assert.equal(rom.readUInt32LE(0x3e1a4), 0x08167d80);
  assert.equal(rom.readUInt32LE(0x370), 0x0813594c);
  assert.equal(rom.readUInt32LE(0x9fb0), 0x08133ed8);
  assert.equal(rom.readUInt32LE(0xa990), 0x08133f40);
  assert.equal(rom.readUInt16LE(0x9f84), 0x0089);
  assert.equal(rom.readUInt16LE(0xa964), 0x0089);
  assert.equal(rom.readUInt32LE(0x8550), 0x0813594c);
  assert.equal(rom.readUInt32LE(0xa208), 0x08133ed8);
  assert.equal(rom.readUInt32LE(0xabb4), 0x08133f40);
  assert.equal(rom.readUInt16LE(0x84e2), 0x8820);
  assert.equal(rom.readUInt16LE(0xa1ae), 0x8829);
  assert.equal(rom.readUInt16LE(0xab66), 0x8829);
  assert.equal(rom.readUInt32LE(0x86bc), 0x0813594c);
  assert.equal(rom.readUInt16LE(0x8612), 0x8868);
  assert.equal(rom.readUInt32LE(0x23af4), 0x08163e09);
  assert.equal(rom.readUInt32LE(0x23b60), 0x08163e0c);
  for (const pointer of [0x24294, 0x2438c, 0x243a8]) assert.equal(rom.readUInt32LE(pointer), 0x0813aa04);
  assert.equal(rom.readUInt32LE(0x25abc), 0x08167d80);
  assert.equal(rom.readUInt32LE(0x3b81c), 0x0813594c);
  assert.equal(rom.readUInt32LE(0x25b08), 0x08167d80);
  assert.equal(rom.readUInt32LE(0x146f0), 0x0813594c);
  for (const pointer of [0x905c, 0x91a8]) assert.equal(rom.readUInt32LE(pointer), 0x0813594c);
  assert.equal(rom.readUInt32LE(0x2ce48), 0x0804ca78);
  assert.equal(rom.readUInt32LE(0x3fa6c), 0x08167f6c);
  for (const pointer of [0x42420, 0x42548, 0x426bc, 0x42758]) assert.equal(rom.readUInt32LE(pointer), 0x081685d8);
  for (const call of [0xbfd8, 0xbfe2, 0xbfec, 0xbffa]) assert.equal(rom.readUInt16LE(call - 2), 0x1c21);
  assert.equal(rom.subarray(0x3d212, 0x3d218).toString('hex'), 'd01e072849d8');
  assert.equal(rom.subarray(0x3d37a, 0x3d380).toString('hex'), 'd01e07284bd8');
  assert.equal(rom.subarray(0x3cf26, 0x3cf36).toString('hex'), '101c61380006000e192801d9087801e0');
  assert.equal(rom.readUInt16LE(0x3d2be), 0x3702);
  assert.equal(rom.readUInt16LE(0x3d42a), 0x3702);
  assert.deepEqual(sourceTokens(Buffer.from([14, 0x62]), characters), ['<0E>', 'い']);
  assert.deepEqual(encodeDialogue('<0E>', []), Buffer.from([14, 0]));
  for (const color of ['00', '07']) assert.throws(() => encodeDialogue(`<03:${color}>`, []), /Unreviewed text color/);
  assert.throws(() => encodeDialogue('<07>', []), /Unreviewed dialogue control/);
});

test('full CLI is explicit and read-only check and completeness flags cannot leak into default builds', () => {
  assert.deepEqual(dialogueArguments([]), { full: false, check: false, requireComplete: false, sourcePath: undefined });
  assert.deepEqual(dialogueArguments(['game.gba', '--full', '--check', '--require-complete']),
    { full: true, check: true, requireComplete: true, sourcePath: 'game.gba' });
  assert.throws(() => dialogueArguments(['--check']), /require --full/);
  assert.throws(() => dialogueArguments(['--require-complete']), /require --full/);
  assert.throws(() => dialogueArguments(['--unknown']), /Unknown option/);
  assert.throws(() => dialogueArguments(['--large-text']), /retired/);
  assert.throws(() => dialogueArguments(['one.gba', 'two.gba']), /at most one/);
});

test('read-only full CLI emits complete large JSON reports and never starts a build on invalid entries', () => {
  const directory = mkdtempSync(join(tmpdir(), 'momotarou-full-check-'));
  try {
    mkdirSync(join(directory, 'translations'));
    for (const name of ['menus', 'battle', 'overworld']) {
      writeFileSync(join(directory, 'translations', `${name}.zh-Hant.json`), JSON.stringify({ entries: [] }));
    }
    const entries = Array.from({ length: 1000 }, (_, index) => ({ offset: (0x1000 + index).toString(16),
      translation: '甲', status: 'translated-draft' }));
    writeFileSync(join(directory, 'translations', 'full-01.zh-Hant.json'), JSON.stringify({ language: 'zh-Hant', entries }));
    const result = spawnSync(process.execPath, [resolve('tools/build-dialogue.mjs'), resolve(DEFAULT_SOURCE),
      '--full', '--check', '--require-complete'], { cwd: directory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.stdout.length > 65536);
    const report = JSON.parse(result.stdout);
    assert.equal(report.errors.length, 1001);
    assert.equal(report.entries, 0);
    assert.equal(report.candidateInventoryComplete, false);
    assert.equal(existsSync(join(directory, 'build')), false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('ROM preservation audit permits only approved pointers, hooks and ff padding allocations', () => {
  const source = Buffer.alloc(1024, 0x12);
  source.fill(0xff, 512);
  const output = Buffer.alloc(2048, 0xff);
  source.copy(output);
  output.writeUInt32LE(0x08000800, 256);
  Buffer.alloc(16, 0xab).copy(output, 512);
  const changes = { pointers: [256], allocations: [{ offset: 512, size: 16 }, { offset: 1024, size: 16 }] };
  assert.doesNotThrow(() => assertPreservedRom(source, output, changes));
  output[300] = 0;
  assert.throws(() => assertPreservedRom(source, output, changes), /Unapproved ROM change at 12c/);
  assert.throws(() => assertPreservedRom(source, output, { pointers: [], allocations: [{ offset: 300, size: 1 }] }), /non-padding/);
});

test('full preflight rejects unsafe evidence, formats, controls, widths and buffers per entry', () => {
  const source = Buffer.alloc(4096, 0xff);
  const glyphMap = new Map([[0x62, 'い']]);
  const makeEntry = (bytes, translation, offset = 128, pointer = 0) => {
    Buffer.from([...bytes, 0]).copy(source, offset);
    source.writeUInt32LE(0x08000000 + offset, pointer);
    return { offset: offset.toString(16), sourceHex: Buffer.from(bytes).toString('hex'),
      pointerOffsets: [pointer], translation, status: 'translated-draft' };
  };
  const entry = makeEntry([9, 3, 0x15, 0x62, 4, 9], '<09><03:15>甲<04><09>');
  const validate = candidate => validateDialogueEntry(source, candidate, glyphMap, { strict: true });
  assert.doesNotThrow(() => validate(entry));
  assert.throws(() => validate({ ...entry, sourceHex: undefined }), /Missing sourceHex/);
  assert.throws(() => validate({ ...entry, pointerOffsets: [] }), /Pointer inventory/);
  assert.throws(() => validate({ ...entry, translation: '甲' }), /controls changed/);
  assert.throws(() => validate(makeEntry([0x62, 3], '甲')), /dangling operand/);
  assert.throws(() => validate(makeEntry([7, 0x62], '甲')), /Unreviewed source byte 07/);
  assert.throws(() => validate(makeEntry([3, 0xff, 0x62], '<03:FF>甲')), /Unreviewed text color/);
  assert.throws(() => validate(makeEntry([5, 0, 0x62], '<KANJI:00>甲')), /unsafe through the original formatter/);
  assert.throws(() => validate(makeEntry([5, 0x25, 0x62], '<KANJI:25>甲')), /unsafe through the original formatter/);
  assert.throws(() => validate(makeEntry([0x62], '甲'.repeat(25))), /Line 1 exceeds 24/);
  assert.doesNotThrow(() => validate(makeEntry([14, 0x62], '<0E>甲')));
  assert.throws(() => validate(makeEntry([14, 0x62], '甲')), /controls changed/);
  assert.throws(() => validate(makeEntry([14, 0x62], '<0E>' + '甲'.repeat(24))), /24 columns/);
  assert.throws(() => validate(makeEntry([0x62], Array(12).fill('甲'.repeat(24)).join('\n'))), /680 bytes/);
  assert.throws(() => validate(makeEntry([...Buffer.from('%s')], '<FMT:%s>')), /call-site evidence/);
  assert.throws(() => validate(makeEntry([...Buffer.from('%d')], '甲'.repeat(16) + '<FMT:%d>')), /24 columns/);
  assert.doesNotThrow(() => validate(makeEntry([...Buffer.from('%02d')], '甲'.repeat(22) + '<FMT:%02d>')));
  assert.throws(() => validate(makeEntry([...Buffer.from('%d')], '<FMT:%s>')), /placeholders changed/);
  assert.throws(() => sourceTokens(Buffer.from([5]), glyphMap), /Dangling control/);
  assert.deepEqual(sourceTokens(Buffer.from('%3d%s'), glyphMap), ['<FMT:%3d>', '<FMT:%s>']);
});

test('Shift-JIS selectors validate exact source independently of the custom character map', () => {
  const entries = readFullShards().flatMap(shard => shard.entries)
    .filter(entry => entry.sourceEncoding === 'shift_jis' && entry.classification === 'player-visible');
  assert.equal(entries.length, 5);
  for (const entry of entries) {
    const validate = candidate => validateDialogueEntry(rom, candidate, new Map(), { strict: true });
    assert.doesNotThrow(() => validate(entry));
    assert.equal(validate(entry).sourceHex, entry.sourceHex);
    assert.throws(() => validate({ ...entry, sourceEncoding: 'utf8' }), /Unsupported sourceEncoding/);
    assert.throws(() => validate({ ...entry, source: entry.source + ' ' }), /Shift-JIS source text changed/);
    assert.throws(() => validate({ ...entry, sourceHex: '82a0' + entry.sourceHex.slice(4) }), /Source bytes changed/);
    assert.throws(() => validate({ ...entry, sourceHex: undefined }), /Missing sourceHex/);
    assert.throws(() => validate({ ...entry, pointerOffsets: [] }), /caller pointer evidence/);
    assert.throws(() => validate({ ...entry, translation: '甲'.repeat(6) }), /five columns/);
    for (const translation of ['甲\n乙', '<09>甲', '<KANJI:80>', '<FMT:%s>']) {
      assert.throws(() => validate({ ...entry, translation }), /literal single-line/);
    }
    const glyphs = [...new Set(entry.translation)];
    const encoded = encodeDialogue(entry.translation, glyphs);
    assert.equal(encoded.length, 10);
    for (let cursor = 0; cursor < encoded.length - 1; cursor += 3) {
      assert.equal(encoded[cursor], 2);
      assert.ok(encoded[cursor + 1] >= 0x40 && encoded[cursor + 1] <= 0x7f);
      assert.ok(encoded[cursor + 2] >= 0x40 && encoded[cursor + 2] <= 0x7f);
    }
    assert.equal(encoded.at(-1), 0);
  }
});

test('Shift-JIS validation rejects malformed bytes, early NUL, unknown callers and changed ROMs', () => {
  const source = Buffer.alloc(256, 0xff);
  const validate = (bytes, text) => {
    source.fill(0xff);
    Buffer.concat([bytes, Buffer.from([0])]).copy(source, 128);
    const entry = { offset: '80', sourceEncoding: 'shift_jis', sourceHex: bytes.toString('hex'),
      source: text, translation: '甲', pointerOffsets: [0] };
    return validateDialogueEntry(source, entry, new Map(), { strict: true });
  };
  assert.throws(() => validate(Buffer.from([0x83]), ''), /encoded data was not valid/);
  assert.throws(() => validate(Buffer.from([0x83, 0x58, 0, 0x83, 0x65]), ''), /early terminator/);
  assert.throws(() => validate(Buffer.from('%s'), '%s'), /source controls or formats/);
  assert.throws(() => validate(Buffer.from([3, 0x15]), '\x03\x15'), /source controls or formats/);
  assert.throws(() => validate(Buffer.from([0x83, 0x58]), 'ス'), /Unreviewed Shift-JIS renderer caller/);
  const entry = readFullShards().flatMap(shard => shard.entries).find(entry => entry.offset === '4d214');
  const changed = Buffer.from(rom);
  changed[0] ^= 1;
  assert.throws(() => validateDialogueEntry(changed, entry, new Map(), { strict: true }), /requires verified ROM/);
});

test('Shift-JIS selector calls reach the existing code02 hook and advance three source bytes', () => {
  for (const [call, target] of [[0x36d7c, 0x3d180], [0x3d1b8, 0x3d5c0], [0x3d204, 0x3ce80]]) {
    assert.deepEqual(rom.subarray(call, call + 4), thumbCall(call, target));
  }
  assert.equal(rom.readUInt32LE(0x36e2c), 0x0813e814);
  assert.equal(rom.subarray(0x36d70, 0x36d7c).toString('hex'), '441c8000401902680220211c');
  assert.equal(rom.subarray(0x36d84, 0x36d88).toString('hex'), '0428f3d9');
  assert.equal(rom.readUInt16LE(0x36d9e), 0x2305);
  for (let stage = 1; stage <= 5; stage++) {
    assert.equal(rom.readUInt32LE(0x13e810 + stage * 4), 0x0804d220 - stage * 12);
  }
  assert.equal(rom.subarray(0x3ce84, 0x3ce90).toString('hex'), '29680a780020085600284ada');
  assert.equal(rom.subarray(0x3cf26, 0x3cf36).toString('hex'), '101c61380006000e192801d9087801e0');
  assert.equal(rom.subarray(0x3d1ee, 0x3d1f2).toString('hex'), '00208046');
  assert.equal(rom.subarray(0x3d208, 0x3d218).toString('hex'), '021c01204042824273d0d01e072849d8');
  assert.equal(rom.subarray(0x3d2ac, 0x3d2b0).toString('hex'), '43469918');
  assert.equal(rom.subarray(0x3d2bc, 0x3d2c4).toString('hex'), '3980023700239846');
  assert.equal(rom.subarray(0x3d2fa, 0x3d308).toString('hex'), '2868411c29604078002800d07ce7');
  const hooks = readFileSync(new URL('./glyph-hooks.s', import.meta.url), 'utf8');
  assert.match(hooks, /sjis_glyph_hook:\s+push \{r0, r2-r7, lr\}\s+movs r0, r5\s+movs r1, r2\s+mov r2, r8\s+bl chinese_tile\s+movs r1, r0/);
  const loader = readFileSync(new URL('./glyph-loader.c', import.meta.url), 'utf8');
  assert.match(loader, /if \(code != 2 \|\| bank != 0\) return code \+ bank;/);
  assert.match(loader, /high = cursor\[1\];\s+uint32_t low = cursor\[2\];/);
  assert.match(loader, /\*text \+= 2;/);
});

test('all accepted entries pass the final encoding integrity gate without building a ROM', () => {
  const existing = ['menus', 'battle', 'overworld'].flatMap(name =>
    JSON.parse(readFileSync(new URL(`../translations/${name}.zh-Hant.json`, import.meta.url))).entries);
  const report = prepareFullDialogue(rom, existing, readFullShards(), { candidates: extractCandidates(rom).entries });
  const entries = report.entries;
  const glyphs = [...new Set(entries.flatMap(entry => translationParts(entry.translation))
    .filter(part => !part.startsWith('<') && part !== '\n' && part !== ' '))];
  assert.equal(entries.filter(entry => entry.sourceEncoding === 'shift_jis').length, 5);
  assert.ok(!report.blocked.some(entry => ['4d1e4', '4d1f0', '4d1fc', '4d208', '4d214'].includes(entry.offset)));
  for (const entry of entries) {
    const bytes = Buffer.from(entry.sourceHex, 'hex');
    const encoded = encodeDialogue(entry.translation, glyphs);
    assert.doesNotThrow(() => validateDialogueEncoding(bytes, entry, encoded, characters), entry.offset);
  }
  const entry = entries.find(entry => entry.sourceEncoding === 'shift_jis');
  assert.throws(() => validateDialogueEncoding(Buffer.from(entry.sourceHex, 'hex'),
    { ...entry, translation: '<09>' + entry.translation }, encodeDialogue(entry.translation, glyphs), characters), /controls changed/);
  assert.throws(() => validateDialogueEncoding(Buffer.from(entry.sourceHex, 'hex'), entry, Buffer.from('%d\0'), characters), /placeholders changed/);
});

test('verified string callers bound real tables and remeasure translated argument names', () => {
  const entry = { offset: '136159' };
  const original = boundedStringArguments(rom, entry, characters);
  assert.equal(original.length, 1);
  assert.equal(original[0].length, 82);
  const offset = rom.readUInt32LE(0x135950) - 0x08000000;
  const replacement = { offset: offset.toString(16), sourceHex: dialogueSource(rom, offset).toString('hex'),
    translation: '甲'.repeat(24) };
  const selected = new Map([[offset, { entry: replacement, strict: false }]]);
  const expanded = boundedStringArguments(rom, entry, characters, selected);
  assert.deepEqual(expanded[0][0], { bytes: 72, columns: 24, measured: 72 });
  selected.set(offset, { entry: { ...replacement, translation: '甲\n乙' }, strict: false });
  assert.throws(() => boundedStringArguments(rom, entry, characters, selected), /single-line name/);
  assert.equal(boundedStringArguments(rom, { offset: '80', argumentBounds: [99999] }, characters), undefined);
  const changed = Buffer.from(rom);
  changed[0] ^= 1;
  assert.throws(() => boundedStringArguments(changed, entry, characters), /verified ROM/);
});

test('mask completion argument uses only the six selectable missing parts', () => {
  assert.equal(rom.readUInt32LE(0x9a54), 0x08133e64);
  assert.equal(rom.readUInt16LE(0x9a14), 0x2805);
  assert.equal(rom.subarray(0x9a32, 0x9a38).toString('hex'), '890009180b68');
  assert.equal(boundedStringArguments(rom, { offset: '139c1f' }, characters)[0].length, 6);
});

test('guessing repeats one of fourteen names and swapping selects two of four board names', () => {
  assert.equal(rom.readUInt32LE(0x11914), 0x0804be80);
  assert.equal(rom.subarray(0x117f0, 0x117fa).toString('hex'), '2678b000c01803680093');
  assert.deepEqual(boundedStringArguments(rom, { offset: '16500d' }, characters).map(pool => pool.length), [14, 14]);
  assert.equal(rom.readUInt32LE(0x2c9f8), 0x0804ca98);
  assert.equal(rom.readUInt32LE(0x2c9fc), 0x0804ca78);
  assert.equal(rom.subarray(0x2c9c6, 0x2c9cc).toString('hex'), '032007400324');
  assert.equal(rom.readUInt16LE(0x2c9d2), 0x4026);
  assert.deepEqual(boundedStringArguments(rom, { offset: '166ca5' }, characters).map(pool => pool.length), [4, 4]);
});

test('race runtime opponent pointer has two literal writers and a 256-byte tutorial buffer', () => {
  assert.equal(rom.readUInt32LE(0x19478), 0x03000000);
  assert.equal(rom.subarray(0x19436, 0x1943c).toString('hex'), 'a32000010b18');
  assert.equal(rom.subarray(0x19444, 0x1944e).toString('hex'), '104a002800d0104a1a60');
  assert.equal(rom.readUInt32LE(0x19488), 0x08163ec0);
  assert.equal(rom.readUInt32LE(0x1948c), 0x08163ec4);
  assert.equal(rom.subarray(0x1625a, 0x16268).toString('hex'), '932212018c18a3231b01c8180268');
  const variants = boundedStringArguments(rom, { offset: '165ae7' }, characters)[0];
  assert.deepEqual(variants, [{ bytes: 3, columns: 3, measured: 3 }, { bytes: 6, columns: 4, measured: 4 }]);
  const sourceHex = dialogueSource(rom, 0x165ae7).toString('hex');
  const controls = sourceTokens(Buffer.from(sourceHex, 'hex'), characters).filter(part => part === '<09>').join('');
  const translation = controls + '<FMT:%s>\n' + Array(3).fill('甲'.repeat(24)).join('\n') + '\n';
  const entry = { offset: '165ae7', sourceHex, pointerOffsets: [0x16398], translation };
  const glyphs = ['甲'];
  const remaining = 256 - (encodeDialogue(translation, glyphs).length - 2 + 6);
  assert.ok(remaining >= 0 && remaining < 24);
  assert.doesNotThrow(() => validateDialogueEntry(rom, { ...entry, translation: translation + ' '.repeat(remaining) }, characters, { strict: true }));
  assert.throws(() => validateDialogueEntry(rom, { ...entry, translation: translation + ' '.repeat(remaining + 1) }, characters,
    { strict: true }), /Text buffer exceeds 256 bytes \(257\)/);
});

test('race ranking uses thirty 28-byte records, ranks 1..8 and fixed two-digit time fields', () => {
  assert.equal(rom.readUInt32LE(0x34598), 0x0804cb00);
  assert.equal(rom.subarray(0x34516, 0x34520).toString('hex'), '6178c800401a80001e4a');
  assert.equal(rom.readUInt16LE(0x34510), 0x1c75);
  assert.equal(rom.readUInt16LE(0x345a8), 0x2e07);
  const variants = boundedStringArguments(rom, { offset: '16768c' }, characters)[0];
  assert.equal(variants.length, 30);
  const entry = readFullShards().flatMap(shard => shard.entries).find(entry => entry.offset === '16768c');
  assert.doesNotThrow(() => validateDialogueEntry(rom, entry, characters, { strict: true }));
});

test('all five new callers remeasure selected translated names and ignore blocked replacements', () => {
  const entries = readFullShards().flatMap(shard => shard.entries);
  for (const [offset, pointer] of [[0x139c1f, 0x133e64], [0x16500d, 0x4be80], [0x166ca5, 0x4ca78],
    [0x165ae7, 0x19488], [0x16768c, 0x4cb00]]) {
    const entry = entries.find(entry => entry.offset === offset.toString(16));
    const nameOffset = rom.readUInt32LE(pointer) - 0x08000000;
    const replacement = { offset: nameOffset.toString(16), sourceHex: dialogueSource(rom, nameOffset).toString('hex'),
      translation: '甲'.repeat(24), status: 'translated-draft',
      pointerOffsets: Array.from({ length: rom.length / 4 }, (_, index) => index * 4)
        .filter(position => rom.readUInt32LE(position) === nameOffset + 0x08000000) };
    const selected = new Map([[nameOffset, { entry: replacement, strict: true }]]);
    const variants = boundedStringArguments(rom, entry, characters, selected);
    for (const pool of variants) assert.deepEqual(pool[0], { bytes: 72, columns: 24, measured: 72 });
    assert.throws(() => validateDialogueEntry(rom, entry, characters, { strict: true, selected }), /24 columns|256 bytes/);
    replacement.status = 'blocked';
    assert.deepEqual(boundedStringArguments(rom, entry, characters, selected), boundedStringArguments(rom, entry, characters));
    replacement.status = 'translated-draft';
    replacement.translation = '甲\n乙';
    assert.throws(() => boundedStringArguments(rom, entry, characters, selected), /single-line name/);
  }
});

test('preformatted rental and meal names fit real 20-byte slots including NUL', () => {
  assert.equal(rom.readUInt16LE(0x9f74), 0x20a0);
  assert.equal(rom.readUInt16LE(0xa954), 0x2050);
  assert.equal(rom.subarray(0x9f80, 0x9f86).toString('hex'), 'a20011198900');
  assert.equal(rom.subarray(0xa960, 0xa966).toString('hex'), 'a20011198900');
  assert.equal(rom.readUInt16LE(0x9fa2), 0x2c07);
  assert.equal(rom.readUInt16LE(0xa982), 0x2c03);
  const entries = readFullShards().flatMap(shard => shard.entries);
  for (const [offset, pointer] of [[0x163b0e, 0x133ed8], [0x163b31, 0x133f40]]) {
    const entry = entries.find(entry => entry.offset === offset.toString(16));
    const nameOffset = rom.readUInt32LE(pointer) - 0x08000000;
    const name = { offset: nameOffset.toString(16), sourceHex: dialogueSource(rom, nameOffset).toString('hex'),
      translation: '甲'.repeat(4) };
    const selected = new Map([[nameOffset, { entry: name, strict: false }]]);
    assert.doesNotThrow(() => validateDialogueEntry(rom, entry, characters, { strict: true, selected }));
    name.translation += ' ';
    assert.throws(() => validateDialogueEntry(rom, entry, characters, { strict: true, selected }), /Text buffer exceeds 20 bytes \(21\)/);
  }
});

test('preformatted item confirmation fits exactly the 64 bytes after sp+20 in an 84-byte frame', () => {
  assert.equal(rom.readUInt16LE(0x2e2), 0xb095);
  assert.equal(rom.readUInt16LE(0x3e4), 0xa805);
  const entry = { offset: '1300cf', sourceHex: dialogueSource(rom, 0x1300cf).toString('hex'),
    pointerOffsets: [0x40c], translation: '<09><1B><FMT:%s><1D>\n<09>' };
  const nameOffset = rom.readUInt32LE(0x135950) - 0x08000000;
  const name = { offset: nameOffset.toString(16), sourceHex: dialogueSource(rom, nameOffset).toString('hex'),
    translation: '甲'.repeat(19) + ' ' };
  const selected = new Map([[nameOffset, { entry: name, strict: false }]]);
  assert.doesNotThrow(() => validateDialogueEntry(rom, entry, characters, { strict: true, selected }));
  name.translation += ' ';
  assert.throws(() => validateDialogueEntry(rom, entry, characters, { strict: true, selected }), /Text buffer exceeds 64 bytes \(65\)/);
});

test('full preflight preserves drafts, accepts token-aligned suffixes and rejects conflicts', () => {
  const source = Buffer.alloc(512, 0xff);
  Buffer.from([0x62, 0x62, 0]).copy(source, 128);
  source.writeUInt32LE(0x08000080, 0);
  source.writeUInt32LE(0x08000081, 4);
  const entry = { offset: '80', sourceHex: '6262', pointerOffsets: [0], translation: '甲', status: 'translated-draft' };
  const tail = { offset: '81', sourceHex: '62', pointerOffsets: [4], translation: '乙', status: 'translated-draft' };
  const shard = entries => ({ name: 'full-01.zh-Hant.json', language: 'zh-Hant', entries });
  const options = { characters: new Map([[0x62, 'い']]), candidates: [entry, tail] };
  const merged = prepareFullDialogue(source, [entry], [shard([{ ...entry, translation: '丙' }])], options);
  assert.equal(merged.entries.length, 1);
  assert.equal(merged.entries[0].translation, '甲');
  assert.equal(merged.duplicates.length, 1);
  assert.equal(merged.errors.length, 0);
  assert.equal(merged.candidateInventoryComplete, false);
  const legacy = { ...entry, sourceHex: undefined, source: 'いい', pointerOffsets: undefined };
  assert.equal(prepareFullDialogue(source, [legacy], [shard([entry])], options).errors.length, 0);
  const overlap = prepareFullDialogue(source, [], [shard([entry, tail])], options);
  assert.deepEqual(overlap.errors, []);
  assert.equal(overlap.entries.length, 2);
  const conflict = prepareFullDialogue(source, [], [shard([entry, { ...entry, translation: '丙' }])], options);
  assert.ok(conflict.errors.some(error => /Conflicting/.test(error.message)));
  const blocked = prepareFullDialogue(source, [entry], [shard([{ ...tail, status: 'blocked', translation: '' }])],
    { ...options, requireComplete: true });
  assert.equal(blocked.blocked.length, 1);
  assert.ok(blocked.errors.some(error => /Incomplete/.test(error.message)));
  assert.equal(blocked.status, 'partial-draft-not-full-game');
  const suffix = prepareFullDialogue(source, [], [shard([tail])], { ...options,
    candidates: [{ ...entry, byteLength: 2 }, tail] });
  assert.deepEqual(suffix.errors, []);
  source[128] = 5;
  const kanji = { ...entry, sourceHex: '0562', translation: '<KANJI:62>' };
  const operand = prepareFullDialogue(source, [], [shard([kanji, tail])], { ...options,
    candidates: [{ ...kanji, byteLength: 2 }, tail] });
  assert.ok(operand.errors.some(error => /inside source token/.test(error.message)));
  const withoutInventory = prepareFullDialogue(source, [], [shard([kanji, tail])], { characters: options.characters });
  assert.ok(withoutInventory.errors.some(error => /not a token-aligned suffix/.test(error.message)));
  const offsets = new Set();
  sourceTokens(Buffer.from([5, 0x62, 0x25, 0x33, 0x64, 0x62]), options.characters, { offsets });
  assert.deepEqual([...offsets], [0, 2, 5]);
});

test('full allocation keeps Thumb code in original padding and data in ff-filled 8MB expansion', () => {
  const source = Buffer.alloc(0x400000, 0xff);
  source.fill(0x77, 0, 0x3e8000);
  const allocator = createDialogueAllocator(source, source, 0x3e8000, { full: true });
  assert.equal(allocator.output.length, 0x800000);
  assert.equal(allocator.allocate(Buffer.alloc(0x20000, 0x12), 'font'), 0x400000);
  const code = allocator.allocate(Buffer.alloc(128, 0x34), 'code', true);
  assert.equal(code, 0x3e8000);
  assert.doesNotThrow(() => thumbCall(0x3d2ac, code));
  assert.equal(allocator.output[0x420000], 0xff);
  assert.deepEqual(allocator.output.subarray(0, code), source.subarray(0, code));
  assert.throws(() => allocator.allocate(Buffer.alloc(0x20000), 'oversized-code', true), /original code padding/);
  assert.throws(() => allocator.allocate(Buffer.alloc(0x400000), 'oversized-data'), /ROM space/);
  assert.throws(() => createDialogueAllocator(source, source, 0x100), /original padding/);
  const old = createDialogueAllocator(source, source, 0x3e8000);
  assert.equal(old.output.length, source.length);
  assert.equal(old.allocate(Buffer.alloc(5), 'data'), 0x3e8000);
  assert.equal(old.nextOffset(true), 0x3e8008);
});

test('dialogue encoder preserves controls and format arguments with extended glyph IDs', () => {
  const glyphs = Array.from({ length: 4096 }, (_, index) => String.fromCodePoint(0x4e00 + index));
  assert.deepEqual(encodeDialogue(`<09>${glyphs[0]}${glyphs[65]}${glyphs[4095]}<KANJI:80><06:05><FMT:%3d><FMT:%s>\n <0D>`, glyphs),
    Buffer.from([9, 2, 0x40, 0x40, 2, 0x41, 0x41, 2, 0x7f, 0x7f, 5, 0x80, 6, 5, 37, 51, 100, 37, 115, 10, 32, 13, 0]));
  assert.throws(() => translationParts('<KANJI:ZZ>'), /Malformed/);
  assert.throws(() => encodeDialogue('<02>', glyphs), /Unreviewed/);
  assert.throws(() => encodeDialogue('?', glyphs), /Unmapped/);
  glyphs.push('越');
  assert.throws(() => encodeDialogue('越', glyphs), /Unmapped/);
});

test('dialogue source and encoder preserve embedded zero operands', () => {
  const source = dialogueSource(rom, 0x15311b);
  assert.ok(source.length > 2);
  assert.equal(source.subarray(0, 6).toString('hex'), '0906001b0580');
  assert.ok(decodeText(source, characters).endsWith('<1D><09>'));
  assert.deepEqual(encodeDialogue('<09><06:00><1B>好<KANJI:00><1D><09>', ['好']),
    Buffer.from([9, 6, 0, 0x1b, 2, 0x40, 0x40, 5, 0, 0x1d, 9, 0]));
  assert.throws(() => dialogueSource(Buffer.from([0, 6, 0]), 1), /Unterminated/);
  assert.throws(() => dialogueSource(Buffer.alloc(1026, 0x62), 1), /oversized/);
  assert.throws(() => dialogueSource(rom, -1));
});

test('large dialogue emits quadrant rows and preserves portrait, page and cache limits', () => {
  const glyphs = new Map([['甲', [0, 1, 2, 3]], ['乙', [4, 5, 6, 7]]]);
  assert.deepEqual(encodeLargeDialogue([['甲乙']], glyphs), Buffer.from([
    9, 2, 64, 64, 2, 64, 65, 2, 64, 68, 2, 64, 69,
    10, 2, 64, 66, 2, 64, 67, 2, 64, 70, 2, 64, 71, 9, 0,
  ]));
  const paged = encodeLargeDialogue([['甲'], ['乙']], glyphs, { portrait: 0 });
  assert.deepEqual([...paged.subarray(0, 4)], [9, 6, 0, 2]);
  assert.ok(paged.includes(Buffer.from([9, 10, 10, 2])));
  assert.deepEqual([...paged.subarray(-2)], [9, 0]);
  assert.throws(() => encodeLargeDialogue([['甲'.repeat(10)]], glyphs), /width/);
  assert.throws(() => encodeLargeDialogue([['甲', '乙']], glyphs), /one line/);
  assert.throws(() => encodeLargeDialogue([['丙']], glyphs), /Missing large/);
  const many = Array.from({ length: 15 }, (_, index) => String.fromCodePoint(0x4e00 + index));
  const unique = new Map(many.map((character, index) => [character, [0, 1, 2, 3].map(part => index * 4 + part)]));
  assert.throws(() => encodeLargeDialogue([[many.join('')]], unique), /width/);
  unique.set('一', [4096, 1, 2, 3]);
  assert.throws(() => encodeLargeDialogue([['一']], unique), /Invalid large tile/);
});

test('large labels have two aligned rows without dialogue wait controls', () => {
  const glyphs = new Map([['甲', [0, 1, 2, 3]], ['乙', [4, 5, 6, 7]]]);
  assert.deepEqual(encodeLargeLabel('甲乙', glyphs), Buffer.from([
    2, 64, 64, 2, 64, 65, 2, 64, 68, 2, 64, 69,
    10, 2, 64, 66, 2, 64, 67, 2, 64, 70, 2, 64, 71, 0,
  ]));
  assert.throws(() => encodeLargeLabel('', glyphs), /width/);
  assert.throws(() => encodeLargeLabel('甲'.repeat(10), glyphs), /width/);
});

test('battle results preserve dynamic argument order and separate native rows from numbers', () => {
  const glyphs = new Map([['甲', [0, 1, 2, 3]], ['乙', [4, 5, 6, 7]]]);
  const encoded = encodeBattleResult({ subject: '%s', message: '乙' }, glyphs);
  assert.deepEqual(encoded.subarray(0, 6), Buffer.from([9, 37, 115, 9, 10, 10]));
  assert.deepEqual(encoded.subarray(6, -5), encodeLargeLabel('乙', glyphs).subarray(0, -1));
  assert.deepEqual(encoded.subarray(-5), Buffer.from([10, 37, 100, 9, 0]));
  assert.deepEqual(encoded.toString('latin1').match(/%[sd]/g), ['%s', '%d']);
  const fixed = encodeBattleResult({ subject: '甲', message: '乙' }, glyphs);
  assert.deepEqual(fixed.toString('latin1').match(/%[sd]/g), ['%d']);
  assert.throws(() => encodeBattleResult({ subject: '%n', message: '乙' }, glyphs), /Missing large/);
  assert.throws(() => encodeBattleResult({ subject: '甲', message: '乙'.repeat(10) }, glyphs), /width/);
});

test('text color controls retain operands and reset without becoming glyphs', () => {
  assert.deepEqual(encodeDialogue('<03:15>甲<04>', ['甲']), Buffer.from([3, 0x15, 2, 0x40, 0x40, 4, 0]));
  assert.equal(decodeText(Buffer.from([3, 0x15, 0x62, 4]), characters), '<03:15>い<04>');
  assert.equal(findTextEnd(Buffer.from([3, 0, 0x62, 0]), 0), 3);
  assert.equal(findTextEnd(Buffer.from([3, 0x15]), 0), -1);
  assert.throws(() => encodeDialogue('<03:FF>甲<04>', ['甲']), /Unreviewed text color/);
  assert.throws(() => encodeDialogue('<03>', []), /Unreviewed dialogue/);
});

test('Thumb calls encode forward and backward branches and reject out-of-range targets', () => {
  for (const displacement of [-0x400000, -6, 0, 6, 0x3ffffe]) {
    const offset = 0x400000;
    const encoded = thumbCall(offset, offset + 4 + displacement);
    const unsigned = ((encoded.readUInt16LE(0) & 0x7ff) << 12) | ((encoded.readUInt16LE(2) & 0x7ff) << 1);
    const decoded = (unsigned << 9) >> 9;
    assert.equal(decoded, displacement);
    assert.equal(encoded.readUInt16LE(0) & 0xf800, 0xf000);
    assert.equal(encoded.readUInt16LE(2) & 0xf800, 0xf800);
  }
  assert.throws(() => thumbCall(0, 5));
  assert.throws(() => thumbCall(0, 0x400004));
});

test('dialogue translations preserve exact sources, dialogue controls and format argument order', () => {
  const catalog = { entries: ['battle', 'overworld'].flatMap(name =>
    JSON.parse(readFileSync(new URL(`../translations/${name}.zh-Hant.json`, import.meta.url))).entries) };
  const glyphs = [...new Set(catalog.entries.flatMap(entry => translationParts(entry.translation))
    .filter(part => !part.startsWith('<') && part !== '\n' && part !== ' '))];
  assert.ok(glyphs.length > 64);
  const controls = text => text.match(/<03:[0-9A-F]{2}>|<04>|<06:[0-9A-F]{2}>|<09>|<0D>|<1B>|<1D>/g) ?? [];
  const formats = bytes => [...bytes.toString('latin1').matchAll(/%[0-9]*[sd]/g)].map(match => match[0]);
  const offsets = new Set();
  for (const entry of catalog.entries) {
    assert.ok(!offsets.has(entry.offset));
    offsets.add(entry.offset);
    const offset = Number.parseInt(entry.offset, 16);
    const source = dialogueSource(rom, offset);
    const decoded = decodeText(source, characters);
    if (entry.sourceHex) assert.equal(source.toString('hex'), entry.sourceHex);
    else assert.equal(decoded, entry.source, entry.offset);
    assert.deepEqual(controls(entry.translation), controls(decoded), entry.offset);
    const encoded = encodeDialogue(entry.translation, glyphs);
    assert.deepEqual(formats(encoded), formats(source), entry.offset);
    assert.ok(encoded.length <= 680, entry.offset);
    for (const line of entry.translation.split('\n')) {
      const visible = translationParts(line).filter(part => !part.startsWith('<') || part.startsWith('<KANJI:'));
      assert.ok(visible.length <= 24, `Overlong line at ${entry.offset}: ${line}`);
    }
  }
});

test('recognizes the supplied revision without changing its bytes', () => {
  const before = Buffer.from(rom);
  const report = inspectRom(rom);
  assert.equal(report.sha256, SOURCE_SHA256);
  assert.equal(report.size, 0x400000);
  assert.equal(report.gameCode, 'AMMJ');
  assert.equal(report.revision, 1);
  assert.equal(report.headerChecksumValid, true);
  assert.deepEqual(rom, before);
});

test('rejects a different ROM revision or damaged input', () => {
  assert.throws(() => inspectRom(Buffer.alloc(192)), /Unsupported source ROM/);
  const changed = Buffer.from(rom);
  changed[0x163a43] ^= 1;
  assert.throws(() => inspectRom(changed), /Unsupported source ROM/);
});

test('keeps unknown controls and kanji identifiers explicit', () => {
  assert.equal(decodeText(Buffer.from([9, 5, 0x80, 10, 0x62]), characters),
    '<09><KANJI:80>\nい');
  assert.equal(decodeText(Buffer.from([5]), characters), '<05>');
  assert.equal(decodeText(Buffer.from([6, 5, 0x1b, 0x62]), characters), '<06:05><1B>い');
  assert.equal(decodeText(Buffer.from([6, 0x63, 0x62]), characters), '<06:63>い');
});

test('text boundaries skip zero and control-like operands without crossing scan limits', () => {
  const bytes = Buffer.from([0, 0x62, 5, 0, 6, 0, 6, 5, 0x62, 0, 0x63, 0]);
  assert.equal(findTextEnd(bytes, 0), 0);
  assert.equal(findTextEnd(bytes, 1), 9);
  assert.equal(decodeText(bytes.subarray(1, findTextEnd(bytes, 1)), characters),
    'い<KANJI:00><06:00><06:05>い');
  assert.equal(findTextEnd(bytes, 10), 11);
  assert.equal(findTextEnd(bytes, 1, 9), -1);
  for (const code of [5, 6]) {
    assert.equal(findTextEnd(Buffer.from([0x62, code]), 0), -1);
    assert.equal(findTextEnd(Buffer.from([code, 0]), 0), -1);
    assert.equal(findTextEnd(Buffer.from([code, 0, 0]), 0, 1), -1);
  }
  assert.equal(findTextEnd(Buffer.alloc(0), 0), -1);
  assert.throws(() => findTextEnd(bytes, -1), RangeError);
  assert.throws(() => findTextEnd(bytes, 2, 1), RangeError);
  assert.throws(() => findTextEnd(bytes, 0, bytes.length + 1), RangeError);
  assert.throws(() => findTextEnd(bytes, 0.5), RangeError);
});

test('menu translation drafts match exact source strings at their offsets', () => {
  const catalog = JSON.parse(readFileSync(new URL('../translations/menus.zh-Hant.json', import.meta.url)));
  assert.equal(catalog.sourceSha256, SOURCE_SHA256);
  assert.equal(catalog.language, 'zh-Hant');
  assert.equal(catalog.status, 'prototype-needs-review');
  const offsets = new Set();
  for (const entry of catalog.entries) {
    const offset = Number.parseInt(entry.offset, 16);
    assert.ok(!offsets.has(offset));
    offsets.add(offset);
    const end = rom.indexOf(0, offset);
    assert.equal(decodeText(rom.subarray(offset, end), characters), entry.source, entry.offset);
    assert.ok(entry.translation.length > 0);
  }
});

test('candidate extraction is reproducible and preserves source bytes', () => {
  const before = Buffer.from(rom);
  const catalog = extractCandidates(rom);
  assert.ok(catalog.entries.length >= 2322);
  assert.deepEqual(extractCandidates(rom), catalog);
  assert.equal(new Set(catalog.entries.map(entry => entry.offset)).size, catalog.entries.length);
  const zeroOperand = catalog.entries.find(entry => entry.offset === 0x15311b);
  assert.ok(zeroOperand);
  assert.equal(zeroOperand.boundaryMethod, 'pointer-control-aware');
  assert.ok(zeroOperand.pointerOffsets.includes(0x3bd40));
  assert.ok(zeroOperand.source.startsWith('<09><06:00><1B><KANJI:80>'));
  assert.ok(zeroOperand.rawHex.startsWith('0906001b0580'));
  assert.ok(zeroOperand.byteLength > rom.indexOf(0, zeroOperand.offset) - zeroOperand.offset);
  for (const offset of [0x15d6c0, 0x15d940, 0x15da01, 0x15dbd9]) {
    const colored = catalog.entries.find(entry => entry.offset === offset);
    assert.ok(colored, `Missing color-controlled dialogue at ${offset.toString(16)}`);
    assert.equal(colored.boundaryMethod, 'pointer-control-aware');
    assert.ok(colored.source.includes('<03:15>'));
    assert.equal(colored.rawHex, dialogueSource(rom, offset).toString('hex'));
  }
  for (const entry of catalog.entries) {
    assert.equal(rom[entry.offset + entry.byteLength], 0);
    assert.equal(rom.subarray(entry.offset, entry.offset + entry.byteLength).toString('hex'), entry.rawHex);
    assert.equal(entry.status, 'candidate-unverified');
    if (entry.boundaryMethod === 'pointer-control-aware') {
      assert.ok(entry.pointerOffsets.length > 0);
      assert.equal(findTextEnd(rom, entry.offset, 0x1679ae), entry.offset + entry.byteLength);
    } else {
      assert.equal(entry.boundaryMethod, 'nul-heuristic');
      assert.equal(rom.indexOf(0, entry.offset), entry.offset + entry.byteLength);
    }
    for (const pointerOffset of entry.pointerOffsets) {
      assert.equal(rom.readUInt32LE(pointerOffset), entry.offset + 0x08000000);
    }
  }
  assert.deepEqual(rom, before);
});

test('rasterized glyph validation rejects missing, blank, duplicate and invalid tiles', () => {
  const tiles = Buffer.concat([Buffer.alloc(32, 0x12), Buffer.alloc(32, 0x21)]);
  assert.doesNotThrow(() => validateGlyphTiles(['甲', '乙'], tiles));
  assert.throws(() => validateGlyphTiles(['甲'], tiles), /count mismatch/);
  assert.throws(() => validateGlyphTiles(['甲'], Buffer.alloc(32, 0x11)), /Blank glyph/);
  assert.throws(() => validateGlyphTiles(['甲'], Buffer.alloc(32, 0x13)), /palette/);
  assert.throws(() => validateGlyphTiles(['甲', '乙'], Buffer.alloc(64, 0x12)), /Identical glyphs/);
});

test('both font assets decode and survive lossless literal encoding', () => {
  for (const [offset, size, consumed] of [[0x2f8ecc, 8192, 2472], [0x2f9878, 1824, 753]]) {
    const decoded = decodePairs(rom, offset);
    assert.equal(decoded.data.length, size);
    assert.equal(decoded.consumed, consumed);
    assert.deepEqual(decodePairs(encodeLiteralPairs(decoded.data), 0).data, decoded.data);
  }
  const large = Buffer.alloc(0x18000, 0xab);
  assert.deepEqual(decodePairs(encodeLiteralPairs(large), 0).data, large);
});

test('font decoder rejects truncation, invalid sizes and cyclic pairs', () => {
  const encoded = encodeLiteralPairs(Buffer.from([1, 2, 3, 4]));
  assert.throws(() => decodePairs(encoded.subarray(0, encoded.length - 1), 0), /Truncated/);
  const wrongSize = Buffer.from(encoded);
  wrongSize[1]++;
  assert.throws(() => decodePairs(wrongSize, 0), /Invalid resource size/);
  const cycle = Buffer.from([0x90, 1, 0, 0, 0, 0, 0, 1, 1, 0xff, 0xff, 0xff, 0, 1, 0xff]);
  assert.throws(() => decodePairs(cycle, 0), /Cyclic or oversized/);
});

test('IPS handles unchanged ROMs and records larger than 65535 bytes', () => {
  const source = Buffer.alloc(0x20000);
  const target = Buffer.alloc(0x20000, 0xa5);
  assert.deepEqual(applyPrototypeIps(source, makeIps(source, target)), target);
  assert.deepEqual(applyPrototypeIps(source, makeIps(source, source)), source);
  assert.throws(() => applyPrototypeIps(source, Buffer.from('PATCHEO')));
});

test('IPS expands 4MB to 8MB, preserves ff fill and avoids EOF record addresses', () => {
  const source = Buffer.alloc(0x400000, 0x77);
  const target = Buffer.alloc(0x800000, 0xff);
  source.copy(target);
  target[0x454f46] = 0x12;
  target[target.length - 1] = 0x34;
  const patch = makeIps(source, target);
  assert.equal(patch.readUIntBE(patch.length - 3, 3), target.length);
  assert.deepEqual(applyPrototypeIps(source, patch), target);
  const sameSize = Buffer.from(target);
  sameSize[0x454f46] ^= 0xff;
  assert.deepEqual(applyPrototypeIps(target, makeIps(target, sameSize)), sameSize);
  assert.throws(() => makeIps(target, source), /expansion only/);
  const badLength = Buffer.from(patch);
  badLength.writeUIntBE(source.length, badLength.length - 3, 3);
  assert.throws(() => applyPrototypeIps(source, badLength), /truncates/);
  assert.throws(() => applyPrototypeIps(source, patch.subarray(0, patch.length - 1)), /trailer/);
});

test('IPS validates truncated records and expands RLE records', () => {
  for (const hex of ['000010', '00001000', '0000100002aa', '000010000000', '0000100000000001']) {
    assert.throws(() => applyPrototypeIps(Buffer.alloc(4), Buffer.concat([Buffer.from('PATCH'), Buffer.from(hex, 'hex')])));
  }
  const patch = Buffer.concat([Buffer.from('PATCH'), Buffer.from('00000800000003ab', 'hex'), Buffer.from('EOF')]);
  assert.deepEqual(applyPrototypeIps(Buffer.from([1, 2]), patch),
    Buffer.from([1, 2, 255, 255, 255, 255, 255, 255, 0xab, 0xab, 0xab]));
});

test('prototype changes only verified pointers and padding, preserving original strings and glyphs', () => {
  const catalog = JSON.parse(readFileSync(new URL('../translations/menus.zh-Hant.json', import.meta.url)));
  const glyphs = [...new Set(catalog.entries.flatMap(entry => [...entry.translation]))];
  const tiles = Buffer.alloc(glyphs.length * 32, 0x12);
  const before = Buffer.from(rom);
  const result = buildPrototype(rom, catalog, glyphs, tiles);
  assert.equal(result.manifest.translated.length, 20);
  assert.deepEqual(applyPrototypeIps(rom, result.patch), result.rom);
  assert.deepEqual(rom, before);
  const font = decodePairs(result.rom, result.manifest.fontOffset).data;
  assert.deepEqual(font.subarray(0, 0x2000), decodePairs(rom, 0x2f8ecc).data);
  assert.deepEqual(font.subarray(0x2800, 0x2800 + tiles.length), tiles);
  const permitted = Buffer.alloc(rom.length);
  permitted.fill(1, 0x46a7c, 0x46a80);
  for (const allocation of result.manifest.allocations) {
    permitted.fill(1, allocation.offset, allocation.offset + allocation.size);
  }
  for (const entry of result.manifest.translated) {
    for (const pointer of entry.pointerOffsets) {
      permitted.fill(1, pointer, pointer + 4);
      assert.equal(result.rom.readUInt32LE(pointer), entry.targetOffset + 0x08000000);
    }
    const expected = [...entry.translation].flatMap(character => [5, 0x40 + glyphs.indexOf(character)]);
    assert.deepEqual(result.rom.subarray(entry.targetOffset, entry.targetOffset + expected.length + 1),
      Buffer.from([...expected, 0]));
  }
  for (let offset = 0; offset < rom.length; offset++) {
    if (rom[offset] !== result.rom[offset]) assert.equal(permitted[offset], 1, offset.toString(16));
  }
  assert.throws(() => buildPrototype(rom, catalog, glyphs, tiles.subarray(1)));
});