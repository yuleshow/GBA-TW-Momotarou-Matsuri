import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readRom, inspectRom } from './inspect-rom.mjs';
import { characterMap, decodeText, extractCandidates, findTextEnd } from './extract-text.mjs';
import { sourceTokens, translationParts, validateDialogueEntry } from './build-dialogue.mjs';
import { decodePairs } from './font.mjs';

const noPointerTextGroups = [
  { offsets: [0x130052, 0x130326, 0x1303f0, 0x13040e, 0x13042d],
    name: 'Unreferenced settings/help variants', relatedOwners: [0x130031, 0x130071, 0x1302ff, 0x130349, 0x1303ca, 0x13044b],
    evidence: 'Menu/help tables 130724..13073c, 13087c..130888 and 1308b0..1308bc reference other complete strings. These variants are separated by real NULs, not continuations of those owners.' },
  { offsets: [0x13634c, 0x136376, 0x163abd], name: 'Unreferenced item-message variants',
    relatedOwners: [0x136337, 0x1363a3, 0x163aab, 0x163ac9],
    evidence: 'Item calls reference 136337 at bc9c/bcfc/be08/be34 and 1363a3 at bb6c; shop menu literals reference 163aab at 83ec and 163ac9 at 87f0. No computed owner of these separate messages was established; both %s drafts still lack argument provenance.' },
  { offsets: [0x163f6b], name: 'Unreferenced flag label (possibly diagnostic)',
    relatedOwners: [0x163f49, 0x163f4f, 0x163f57],
    evidence: 'Menu table 1689fc..168a04 owns story/album/status labels; nearby flag label is a distinct NUL-terminated string. Diagnostic use is plausible, not proven.' },
  { offsets: [0x16468e, 0x1646ac, 0x1646c3], name: 'Unreferenced minigame greeting/stage/exit variants',
    relatedOwners: [0x164651, 0x1646d6],
    evidence: 'Active nearby greeting/help literals 368d0, 36e24, 3518c, 36e20 target 164651/1646d6. Selector loop 36d70..36d86 loads labels from 13e814, not these separate custom-encoded messages.' },
  { offsets: [0x165912, 0x165963], name: 'Unreferenced timing-game dialogue variants',
    relatedOwners: [0x165945, 0x16598c],
    evidence: 'Nearby literals 1b0f0 and 1b378 target 165945 and 16598c; real NULs separate the unreferenced intro/result drafts. No base-plus-displacement text path was proven.' },
  { offsets: [0x167168, 0x16716d, 0x1671b1], name: 'Unreferenced race start/quit/refund variants',
    relatedOwners: [0x167171, 0x16718d],
    evidence: 'Race literals 32b54 and 32d9c target prediction and A/B help at 167171/16718d. Start/quit/refund drafts have separate NUL boundaries and no proven computed caller.' },
];

export function auditFalsePointerEvidence(source, result) {
  const packed = decodePairs(source, 0x29718c);
  assert.equal(packed.data.length, 28576);
  assert.equal(0x29718c + packed.consumed, 0x29ab4f);
  assert.equal(source.subarray(0xa2684, 0xa2694).toString('hex'), '000000000088580100000000257f0000');
  for (const [pointer, target] of [[0x2d498, 0x29718c], [0x4fcb8, 0xa2684],
    [0x12fddc, 0x4fc78], [0x51960, 0x12fdd8]]) {
    assert.equal(source.readUInt32LE(pointer), target + 0x08000000);
  }
  assert.equal(0x4fcb4 - 0x4fc78, 5 * 12);
  assert.equal(source.readUInt32LE(0x4fcb4), 0x3c00);
  const proofs = [
    { offset: '161f20', ownerOffset: '161f18', rejectedPointerOffset: 0xa2b2c,
      token: '<KANJI:81>', sourceStorage: 'pcm-sample', storageStart: 'a2694',
      storageEnd: (0xa2694 + source.readUInt32LE(0xa2690)).toString(16),
      evidence: '51960 -> song header 12fdd8; header+4 -> instrument bank 4fc78; instrument 5 (12-byte records) at 4fcb4 is direct PCM, wave pointer 4fcb8 -> a2684. Wave header is 16 bytes, sample length 0x7f25, payload a2694..aa5b9. a2b2c is PCM payload, not a pointer field.' },
    { offset: '167808', ownerOffset: '1677f4', rejectedPointerOffset: 0x297730,
      token: '<FMT:%s>', sourceStorage: 'pair-compressed-resource', storageStart: '29718c',
      storageEnd: '29ab4f',
      evidence: '2d498 -> resource 29718c. decodePairs validates its header, expands 28576 bytes and consumes 14787 bytes through 29ab4f. 297730 is inside compressed input, not a pointer field.' },
  ];
  return proofs.map(proof => {
    const offset = Number.parseInt(proof.offset, 16);
    const owner = result.catalogEntries.find(entry => entry.offset === proof.ownerOffset);
    assert.ok(owner?.translation && owner.status === 'translated-draft');
    const ownerOffset = Number.parseInt(owner.offset, 16);
    const bytes = Buffer.from(owner.sourceHex, 'hex');
    assert.deepEqual(source.subarray(ownerOffset, ownerOffset + bytes.length), bytes);
    const boundaries = new Set();
    const tokens = sourceTokens(bytes, result.characters, { offsets: boundaries });
    assert.ok(tokens.includes(proof.token));
    assert.ok(!boundaries.has(offset - ownerOffset));
    assert.equal(source.readUInt32LE(proof.rejectedPointerOffset), offset + 0x08000000);
    assert.ok(proof.rejectedPointerOffset >= Number.parseInt(proof.storageStart, 16) &&
      proof.rejectedPointerOffset + 4 <= Number.parseInt(proof.storageEnd, 16));
    return { ...proof, classification: 'false-pointer-inside-source-token', status: 'excluded-nontext',
      ownerCatalog: owner.catalog, ownerPointerOffsets: result.references.get(ownerOffset),
      ownerTranslationPresent: true, installationVerified: false, playerVisibilityVerified: false };
  });
}

export function glyphRows(source, code) {
  const tiles = decodePairs(source, 0x2f9878).data;
  const tile = code - 0x80;
  assert.ok(Number.isInteger(tile) && tile >= 0 && tile < tiles.length / 32);
  return Array.from({ length: 8 }, (_, row) => Array.from({ length: 8 }, (_, column) => {
    const packed = tiles[tile * 32 + row * 4 + (column >> 1)];
    return ((packed >> ((column & 1) * 4)) & 15) === 2 ? '##' : '  ';
  }).join(''));
}

export function classifyUnreferenced(source, result) {
  assert.equal(result.metadata.sha256, '938fa27a934ac3f4fa93d4d9e49bd538c2fb41040d0f7a8b2de6343a406f82d3',
    'Fixed-offset ownership audit requires the reviewed original ROM');
  const owners = result.catalogEntries.filter(entry => entry.catalog !== 'full-10.zh-Hant.json' &&
    entry.status !== 'excluded-nontext')
    .flatMap(entry => {
      const offset = Number.parseInt(entry.offset, 16);
      const end = findTextEnd(source, offset, Math.min(offset + 4097, source.length));
      if (end <= offset) return [];
      if (entry.sourceHex && source.subarray(offset, end).toString('hex') !== entry.sourceHex) return [];
      const pointerOffsets = result.references.get(offset) ?? [];
      if (!pointerOffsets.length) return [];
      return [{ offset, end, catalog: entry.catalog, status: entry.status ?? 'existing-draft',
        pointerOffsets, translationPresent: Boolean(entry.translation),
        installationVerified: false, playerVisibilityVerified: false }];
    });
  const unaligned = new Map(result.unreferenced.map(entry => [entry.offset, []]));
  const interiorTargets = new Map();
  const interiorReferences = new Map();
  for (const entry of result.unreferenced) {
    interiorReferences.set(entry.offset, []);
    for (let target = entry.offset + 1; target < entry.offset + entry.byteLength; target++) {
      if (!interiorTargets.has(target)) interiorTargets.set(target, []);
      interiorTargets.get(target).push(entry.offset);
    }
  }
  for (let pointer = 0; pointer + 4 <= source.length; pointer++) {
    const target = source.readUInt32LE(pointer) - 0x08000000;
    if (pointer % 4) unaligned.get(target)?.push(pointer);
    for (const start of interiorTargets.get(target) ?? []) {
      interiorReferences.get(start).push({ pointerOffset: pointer, targetOffset: target.toString(16),
        aligned: pointer % 4 === 0, pointerOwnershipVerified: false });
    }
  }
  const entries = result.unreferenced.map(entry => {
    const end = entry.offset + entry.byteLength;
    const record = { offset: entry.id, sourceEncoding: 'game_custom-candidate',
      source: entry.source, sourceHex: entry.rawHex, endOffset: end.toString(16),
      pointerOffsets: [], unalignedPointerOffsets: unaligned.get(entry.offset),
      rawInteriorReferences: interiorReferences.get(entry.offset),
      status: 'unresolved', classification: 'unresolved-no-owner' };
    const containing = owners.filter(owner => owner.offset < entry.offset && owner.end >= end);
    if (containing.length) return { ...record, status: 'excluded-nontext',
      classification: 'covered-fragment', owners: containing.map(owner => ({ ...owner,
        offset: owner.offset.toString(16), end: owner.end.toString(16),
        fragmentByteOffset: entry.offset - owner.offset })),
      reason: 'Exact source bytes are inside a referenced catalog owner; not an independent missing string. Owner draft coverage does not prove installation or natural gameplay visibility.' };
    const embedded = owners.find(owner => owner.offset > entry.offset && owner.offset < end && owner.end === end);
    if (embedded) return { ...record, status: 'excluded-nontext', classification: 'misbounded-prefix',
      ownerOffset: embedded.offset.toString(16), catalog: embedded.catalog };
    for (const table of [
      { start: 0x13296c, end: 0x1329b4, pointer: 0x5f84, count: 6,
        consumer: '5ef6/5f16 decode resources returned by 43ec8 using numeric triple fields; 5f20..5f42 copies halfwords to VRAM.' },
      { start: 0x133fd8, end: 0x134110, pointer: 0xb618, count: 26,
        consumer: 'b5e6..b5ea passes 26 numeric triples to 44cc8; 44cfe..44d26 reads +0/+4/+8 resource offsets via 43ec8.' },
    ]) {
      if (entry.offset < table.start || end > table.end || entry.offset % 4) continue;
      assert.equal(source.readUInt32LE(table.pointer), table.start + 0x08000000);
      assert.equal(table.end - table.start, table.count * 12);
      const values = Array.from({ length: table.count * 3 }, (_, index) =>
        source.readUInt32LE(table.start + index * 4));
      assert.ok(values.every(value => value < 0x100000));
      return { ...record, status: 'excluded-nontext', classification: 'resource-offset-table',
        tableStart: table.start.toString(16), tableEnd: table.end.toString(16),
        tablePointerOffsets: [table.pointer], recordBytes: 12,
        fieldOffset: (entry.offset - table.start) % 12,
        reason: table.consumer };
    }
    const callbacks = new Map([[0x142500, 0xa2b5], [0x151a74, 0xa999],
      [0x151a88, 0xa999], [0x151ae4, 0x9fb9], [0x151af8, 0x9fb9], [0x151b4c, 0xa2b5]]);
    if (callbacks.has(entry.offset)) {
      const target = callbacks.get(entry.offset);
      assert.equal(source.readUInt32LE(entry.offset), target + 0x08000000);
      assert.equal(source.readUInt16LE(entry.offset - 4), 0x5a);
      assert.equal(source.readUInt16LE(target - 1) & 0xfe00, 0xb400);
      return { ...record, status: 'excluded-nontext', classification: 'event-function-pointer',
        recordStart: (entry.offset - 4).toString(16), opcode: 0x5a,
        functionOffset: (target - 1).toString(16),
        reason: 'NUL scan stops inside a Thumb callback pointer following event opcode 5a; not a text start.' };
    }
    for (const table of [
      { start: 0x136af4, end: 0x136c0c, stride: 4, pointer: 0x10004,
        consumer: 'ffc0..fffa indexes (row*5+column)*4, reads byte fields, calls ff10' },
      { start: 0x138808, end: 0x138b58, stride: 16, pointer: 0x1de6c,
        consumer: '1de30..1de66 advances 16 bytes, compares time word and dispatches byte +4' },
      { start: 0x13b700, end: 0x13b7f0, stride: 12, pointer: 0x2b514,
        consumer: '2b4b0..2b4c4 reads three words into object +16/+20/+24' },
      { start: 0x13f108, end: 0x13f378, stride: 8, pointer: 0x3a374,
        consumer: '3a344..3a356 indexes by 8 and copies byte field into object +123' },
      { start: 0x136de0, end: 0x136dec, stride: 4, pointer: 0x123b4,
        consumer: '123ba..123c8 reads signed byte, shifts by 8 and adds object coordinate' },
      { start: 0x13ed04, end: 0x13ed14, stride: 4, pointer: 0x3a5a4,
        consumer: '3a574..3a58c reads signed halfwords, shifts by 12 and adds coordinates' },
      { start: 0x13d23c, end: 0x13d264, stride: 4, pointer: 0x31138,
        consumer: '310f6..31116 passes numeric array to 3fbd0 with index; 13d260 is integer 54000' },
      { start: 0x132b0c, end: 0x132b1c, stride: 16, pointer: 0x68bc,
        consumer: '68a8..68c4 selects a binary parameter block, not a text renderer input' },
    ]) {
      if (entry.offset < table.start || end > table.end) continue;
      assert.equal(source.readUInt32LE(table.pointer), table.start + 0x08000000);
      assert.equal((table.end - table.start) % table.stride, 0);
      return { ...record, status: 'excluded-nontext', classification: 'numeric-record-field',
        tableStart: table.start.toString(16), tableEnd: table.end.toString(16),
        tablePointerOffsets: [table.pointer], recordBytes: table.stride,
        recordStart: (entry.offset - (entry.offset - table.start) % table.stride).toString(16),
        fieldOffset: (entry.offset - table.start) % table.stride, reason: table.consumer };
    }
    for (const [start, limit, pointer] of [
      [0x130740, 0x13075c, 0x254], [0x130860, 0x130868, 0x6c8],
      [0x13088c, 0x13089c, 0x784], [0x1308c0, 0x1308d0, 0x800],
      [0x133f18, 0x133f38, 0xa150], [0x133f60, 0x133f70, 0xab0c],
      [0x136680, 0x136688, 0xc6a8], [0x136868, 0x13687c, 0xd870],
      [0x13a214, 0x13a220, 0x20ccc], [0x13ef80, 0x13ef94, 0x13efbc],
      [0x13ef94, 0x13efa8, 0x13efd4],
    ]) {
      if (entry.offset < start || end > limit) continue;
      assert.equal(source.readUInt32LE(pointer), start + 0x08000000);
      assert.ok(source.subarray(entry.offset, end).includes(Buffer.from('ffff', 'hex')));
      return { ...record, status: 'excluded-nontext', classification: 'selection-record-sentinel',
        tableStart: start.toString(16), tableEnd: limit.toString(16), tablePointerOffsets: [pointer],
        recordBytes: 4, fieldOffset: (entry.offset - start) % 4,
        reason: 'Selection records hold byte options and signed halfword sentinels, separate from neighboring label/help pointer tables.' };
    }
    const crossTables = [
      { offset: 0x1308cd, hex: '03ffffffff', boundary: 0x1308d0,
        owners: [[0x1308c0, 0x800], [0x1308d0, 0xe10]],
        reason: 'Selection index 03 and ffff sentinel cross into the next binary lookup table.' },
      { offset: 0x133f35, hex: '07ffff64', boundary: 0x133f38,
        owners: [[0x133f18, 0xa150], [0x133f38, 0xa98c]],
        reason: 'Selection index 07 and ffff sentinel cross into the next price halfword 0064 (100).' },
      { offset: 0x132b2f, hex: 'f0ffffffff296e', boundary: 0x132b34,
        owners: [[0x132b1c, 0x68c8], [0x132b34, 0x6678]],
        reason: 'Signed parameter bytes cross into the Thumb dispatch pointer 08006e29; NUL is inside the pointer.' },
    ];
    const crossTable = crossTables.find(candidate => candidate.offset === entry.offset);
    if (crossTable) {
      assert.equal(entry.rawHex, crossTable.hex);
      for (const [target, pointer] of crossTable.owners) {
        assert.equal(source.readUInt32LE(pointer), target + 0x08000000);
      }
      return { ...record, status: 'excluded-nontext', classification: 'cross-table-fragment',
        boundaryOffset: crossTable.boundary.toString(16), reason: crossTable.reason,
        tableOwners: crossTable.owners.map(([offset, pointer]) => ({ offset: offset.toString(16), pointer })) };
    }
    if ([0x144bc0, 0x144bd4, 0x144be8, 0x144c2c, 0x144c40, 0x144c54,
      0x144c70, 0x144c8c, 0x144ca8].includes(entry.offset)) {
      assert.equal(source.readUInt32LE(entry.offset - 4), 0x00b40046);
      assert.equal(source.readInt32LE(entry.offset), -90);
      assert.ok([0x29, 0x2b].includes(source.readUInt16LE(entry.offset + 4)));
      assert.equal(source.readUInt32LE(entry.offset + 8), 0x31);
      assert.equal(source.readUInt32LE(entry.offset + 12), 0x00800023);
      return { ...record, status: 'excluded-nontext', classification: 'event-integer-operand',
        recordStart: (entry.offset - 4).toString(16), fieldOffset: 4, value: -90,
        reason: 'Event command 0046 00b4 has signed operand ffffffa6 (-90), followed by commands 0029/002b, 0031 and 0023. Scan wrongly includes the next opcode.' };
    }
    if (entry.offset >= 0x131718 && entry.offset < 0x132494 && entry.offset % 4 === 0) {
      const field = (entry.offset - 0x131718) % 36;
      const base = entry.offset - field;
      const names = [24, 28].map(delta => source.readUInt32LE(base + delta) - 0x08000000);
      const numeric = Array.from({ length: 6 }, (_, index) => source.readUInt32LE(base + index * 4));
      if (field < 24 && numeric.every(value => value < source.length) &&
          names.every(offset => owners.some(owner => owner.offset === offset))) {
        return { ...record, status: 'excluded-nontext', classification: 'resource-offset-field',
          recordStart: base.toString(16), recordBytes: 36, fieldOffset: field,
          value: source.readUInt32LE(entry.offset), textPointerFields: [base + 24, base + 28],
          textOffsets: names.map(offset => offset.toString(16)) };
      }
    }
    if ((entry.offset >= 0x13db50 && entry.offset < 0x13e680) ||
        (entry.offset >= 0x13f840 && entry.offset < 0x13fb00)) {
      const base = (entry.offset & ~3) - 24;
      const resources = [8, 12, 16, 20].map(delta => source.readUInt32LE(base + delta) - 0x08000000);
      if (entry.offset === base + 25 && entry.byteLength === 3 &&
          resources.every(offset => offset >= 0x169000 && offset < source.length) &&
          source.readInt32LE(base + 24) < 0 && source.readInt32LE(base + 28) < 0) {
        return { ...record, status: 'excluded-nontext', classification: 'signed-position-field',
          recordStart: base.toString(16), fieldOffset: 24,
          value: source.readInt32LE(base + 24), resourceOffsets: resources.map(offset => offset.toString(16)) };
      }
    }
    if (entry.offset === 0x163878) return { ...record, status: 'excluded-nontext',
      classification: 'diagnostic', reason: 'Literal says text test; no aligned or unaligned caller found.' };
    const group = noPointerTextGroups.find(group => group.offsets.includes(entry.offset));
    if (group) {
      return { ...record, status: 'unreferenced-not-installed', classification: 'text-without-proven-owner',
        group: group.name, installationVerified: false, playerVisibilityVerified: false,
        relatedOwners: group.relatedOwners.map(offset => ({ offset: offset.toString(16),
          pointerOffsets: result.references.get(offset) ?? [],
          catalogs: owners.filter(owner => owner.offset === offset).map(owner => owner.catalog) })),
        reason: group.evidence,
        relocationBlocker: 'No proven text caller or computed table; no authorized relocation. Empty exact-pointer search does not prove dormant code. Raw interior matches are not approved references.' };
    }
    return record;
  });
  const counts = {};
  for (const entry of entries) counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
  return { candidateCount: entries.length, counts,
    computedTextOwnersProven: 0,
    warning: 'All scan candidates retain source evidence. Covered fragments are catalog coverage only. Unreferenced text is not installed and its gameplay reachability is unknown; binary exclusions, raw pointer matches and graphical/unverified areas are not translations. No computed text owner was proven.',
    entries };
}

export function validateNoPointerAudit(source, result, catalog) {
  assert.equal(catalog.sourceSha256, result.metadata.sha256);
  const audit = classifyUnreferenced(source, result);
  assert.equal(audit.candidateCount, 394);
  assert.equal(new Set(audit.entries.map(entry => entry.offset)).size, 394);
  assert.deepEqual(audit.counts, catalog.audit.noPointerAudit.counts);
  const fragments = audit.entries.filter(entry => entry.classification === 'covered-fragment');
  assert.equal(fragments.length, 22);
  assert.equal(Object.keys(catalog.audit.noPointerAudit.fragmentOwners).length, fragments.length);
  for (const candidate of audit.entries) {
    const offset = Number.parseInt(candidate.offset, 16);
    const end = Number.parseInt(candidate.endOffset, 16);
    assert.equal(source.subarray(offset, end).toString('hex'), candidate.sourceHex);
    assert.equal(source[end], 0);
    assert.equal(decodeText(source.subarray(offset, end), result.characters), candidate.source);
    for (const reference of candidate.rawInteriorReferences) {
      assert.equal(source.readUInt32LE(reference.pointerOffset),
        Number.parseInt(reference.targetOffset, 16) + 0x08000000);
      assert.equal(reference.pointerOwnershipVerified, false);
    }
  }
  for (const fragment of fragments) {
    assert.ok(fragment.owners.some(owner => owner.offset === catalog.audit.noPointerAudit.fragmentOwners[fragment.offset]));
    for (const owner of fragment.owners) {
      assert.ok(owner.translationPresent && owner.pointerOffsets.length);
      assert.ok(['translated-draft', 'existing-draft'].includes(owner.status));
      for (const pointer of owner.pointerOffsets) {
        assert.equal(source.readUInt32LE(pointer), Number.parseInt(owner.offset, 16) + 0x08000000);
      }
    }
  }
  const readable = audit.entries.filter(entry => entry.classification === 'text-without-proven-owner');
  assert.equal(readable.length, 17);
  assert.equal(catalog.entries.filter(entry => entry.sourceEncoding === 'game_custom' &&
    entry.classification === 'text-without-proven-owner').length, readable.length);
  for (const candidate of readable) {
    const entry = catalog.entries.find(entry => entry.offset === candidate.offset);
    assert.equal(entry?.sourceEncoding, 'game_custom');
    assert.equal(entry.status, 'unreferenced-not-installed');
    assert.equal(entry.sourceHex, candidate.sourceHex);
    assert.equal(entry.source, candidate.source);
    assert.deepEqual(entry.pointerOffsets, []);
    assert.equal(candidate.unalignedPointerOffsets.length, 0);
    assert.ok(entry.translation && entry.blockedReason);
    assert.doesNotMatch(entry.translation, /[\u3040-\u30ff\uff66-\uff9f]/u);
    const protectedTokens = tokens => tokens.filter(token =>
      /^<(?:03:|04>|06:|09>|0D>|0E>|1B>|1D>|FMT:)/.test(token));
    assert.deepEqual(protectedTokens(translationParts(entry.translation)),
      protectedTokens(sourceTokens(Buffer.from(entry.sourceHex, 'hex'), result.characters)));
    for (const owner of candidate.relatedOwners) {
      assert.ok(owner.pointerOffsets.length && owner.catalogs.length);
    }
  }
  assert.deepEqual(readable.flatMap(entry => entry.rawInteriorReferences), [
    { pointerOffset: 0x30d68e, targetOffset: '130347', aligned: false, pointerOwnershipVerified: false },
  ]);
  const falsePointers = auditFalsePointerEvidence(source, result);
  for (const proof of falsePointers) {
    const entry = result.catalogEntries.find(entry => entry.offset === proof.offset);
    assert.equal(entry?.status, 'excluded-nontext');
    assert.deepEqual(entry.pointerOffsets, [proof.rejectedPointerOffset]);
    assert.ok(entry.reason.includes(proof.storageEnd));
  }
  const excluded = audit.entries.filter(entry => entry.status === 'excluded-nontext').length;
  const unresolved = audit.entries.filter(entry => entry.status === 'unresolved').length;
  assert.equal(excluded, catalog.audit.noPointerAudit.excluded);
  assert.equal(unresolved, catalog.audit.noPointerAudit.unresolved);
  assert.equal(readable.length, catalog.audit.noPointerAudit.unreferencedNotInstalled);
  assert.equal(excluded + readable.length + unresolved, audit.candidateCount);
  return { noPointerCandidates: audit.candidateCount, noPointerExcluded: excluded,
    coveredFragments: fragments.length, unreferencedNotInstalled: readable.length,
    noPointerUnresolved: unresolved, falsePointerBlockersRemoved: falsePointers.length,
    sourceBytesAndOwnershipValidated: true, romWritten: false, gameplayVerified: false };
}

export function noPointerReport(source, result, catalog) {
  const validation = validateNoPointerAudit(source, result, catalog);
  const audit = classifyUnreferenced(source, result);
  return { scope: '394 no-aligned-pointer candidates plus only the two authorized false-pointer blockers; Shift-JIS excluded',
    sourceSha256: result.metadata.sha256, validation, classificationCounts: audit.counts,
    confirmedIndependentPlayerVisibleMissing: [],
    confirmedMissingInterpretation: 'No independent player-visible missing text was proven in this scope. This is not a zero-missing-text or full-game-translation claim.',
    unverifiedPlayerVisibleMissingCount: null, computedTextOwnersProven: 0,
    unreferencedNotInstalled: audit.entries.filter(entry => entry.status === 'unreferenced-not-installed').map(entry => ({
      ...entry, translationDraftPresent: Boolean(catalog.entries.find(candidate => candidate.offset === entry.offset)?.translation),
      countedAsTranslated: false,
    })),
    coveredFragments: audit.entries.filter(entry => entry.classification === 'covered-fragment').map(entry => ({
      offset: entry.offset, endOffset: entry.endOffset, classification: entry.classification, owners: entry.owners,
    })),
    falsePointerExclusions: auditFalsePointerEvidence(source, result),
    graphicalAndUnverified: { countedAsTranslated: false, missingCount: null,
      areas: ['image-only/minigame graphics', 'compressed text surfaces', 'endings and natural event reachability',
        'installation and player-visible rendering of catalog drafts'] },
    relocation: 'No proven computed/unaligned text owner authorizes a patch. Preserve raw matches; do not relocate the 17 drafts without caller/table provenance. The two %s drafts also need argument and buffer bounds.',
    engineReportingLimit: 'This audit does not change prepareFullDialogue: its legacy blocked list includes every non-translated-draft status, even exclusions. Use these classifications for semantic missing-text counts, not that raw blocked count.',
  };
}

export function validateSupplementalAudit(source, result, catalog) {
  assert.equal(catalog.sourceSha256, result.metadata.sha256);
  assert.equal(catalog.language, 'zh-Hant');
  const seen = new Set();
  const decoder = new TextDecoder('shift_jis', { fatal: true });
  const protectedTokens = tokens => tokens.filter(token =>
    /^<(?:03:|04>|06:|09>|0D>|0E>|1B>|1D>|FMT:)/.test(token));
  for (const entry of catalog.entries) {
    assert.match(entry.offset, /^[0-9a-f]+$/);
    assert.ok(!seen.has(entry.offset), `Duplicate audit offset ${entry.offset}`);
    seen.add(entry.offset);
    assert.match(entry.sourceHex, /^(?:[0-9a-f]{2})+$/);
    const offset = Number.parseInt(entry.offset, 16);
    const bytes = Buffer.from(entry.sourceHex, 'hex');
    const end = offset + bytes.length;
    assert.ok(end < source.length, `${entry.offset}: source bounds`);
    assert.deepEqual(source.subarray(offset, end), bytes, `${entry.offset}: source bytes`);
    assert.equal(source[end], 0, `${entry.offset}: NUL boundary`);
    assert.deepEqual(entry.pointerOffsets, result.references.get(offset) ?? [], `${entry.offset}: pointers`);
    assert.ok(['shift_jis', 'game_custom'].includes(entry.sourceEncoding));
    const text = entry.sourceEncoding === 'shift_jis' ? decoder.decode(bytes) : decodeText(bytes, result.characters);
    assert.equal(entry.source, text, `${entry.offset}: decoded source`);
    assert.equal(entry.sourceEncoding === 'shift_jis' ? source.indexOf(0, offset) :
      findTextEnd(source, offset, end + 1), end, `${entry.offset}: early terminator`);
    assert.ok(catalog.audit.evidence[entry.evidence], `${entry.offset}: missing ownership evidence`);
    const reviewedStage = entry.sourceEncoding === 'shift_jis' && entry.classification === 'player-visible' &&
      entry.evidence === 'stage-selector';
    assert.ok(['blocked', 'excluded-nontext', 'unreferenced-not-installed'].includes(entry.status) ||
      (reviewedStage && entry.status === 'translated-draft'), 'Only reviewed stage labels may be inserted');
    if (entry.status === 'blocked' || entry.status === 'unreferenced-not-installed') {
      assert.ok(entry.blockedReason && entry.translation, `${entry.offset}: missing blocker or draft`);
    }
    if (entry.translation) {
      assert.doesNotMatch(entry.translation, /[\u3040-\u30ff\uff66-\uff9f]/u, `${entry.offset}: untranslated kana`);
      if (entry.sourceEncoding === 'game_custom') {
        assert.deepEqual(protectedTokens(translationParts(entry.translation)),
          protectedTokens(sourceTokens(bytes, result.characters)), `${entry.offset}: control/format changes`);
      }
    }
    if (entry.classification === 'diagnostic') assert.equal(entry.status, 'excluded-nontext');
  }
  assert.equal(catalog.entries.length, 56);
  assert.equal(catalog.entries.filter(entry => entry.sourceEncoding === 'shift_jis').length, 37);
  assert.equal(catalog.entries.filter(entry => entry.classification === 'diagnostic').length, 32);
  for (const hit of result.metadata.japaneseStrings) {
    const entry = catalog.entries.find(candidate => Number.parseInt(candidate.offset, 16) === hit.offset);
    assert.ok(entry, `Unaudited Shift-JIS scan hit ${hit.offset.toString(16)}`);
    assert.equal(entry.sourceEncoding === 'shift_jis' ? entry.source : entry.scanSource, hit.text);
  }
  for (let index = 0; index < 5; index++) {
    const pointer = 0x13e814 + index * 4;
    const entry = catalog.entries.find(candidate => candidate.pointerOffsets.includes(pointer));
    assert.equal(entry?.classification, 'player-visible');
    assert.equal(entry.status, 'translated-draft');
    assert.equal(entry?.translation, `第${index + 1}關`);
    assert.equal(entry.sourceHex.length / 2, 10);
    assert.equal([...entry.translation].length, 3);
    assert.deepEqual(entry.pointerOffsets, [pointer]);
  }
  for (const [pointer, target] of [[0x55b0, 0x1324c0], [0x5718, 0x1324ec],
    [0x58cc, 0x1325dc], [0x36e2c, 0x13e814], [0xb404, 0x133fac],
    [0x3fa6c, 0x167f6c], [0x3e0b4, 0x167d64]]) {
    assert.equal(source.readUInt32LE(pointer), target + 0x08000000, 'Owner base pointer changed');
  }
  for (const [offset, hex] of [[0x5530, 'e11ca00040190268032037f021fe601c0006040e092cf3d9'],
    [0x5632, 'a11c200140190268022037f0a0fd601c0006040e0e2cf3d9'],
    [0x57ec, 'a11c200140190268022037f0c3fc601c0006040e052cf3d9'],
    [0x36d70, '441c8000401902680220211c06f000fa2406200e0428f3d9'],
    [0x36dbc, '10f080f81b4a0006c00c1f211379194001431171'],
    [0xb4e4, '064bb200d218126823680090404632f089f9'],
    [0x3fa46, '0949601e80004018036801200121fdf718fd'],
    [0x3e084, '0a480b490322cef793fa']]) {
    assert.equal(source.subarray(offset, offset + hex.length / 2).toString('hex'), hex,
      `Reviewed caller changed at ${offset.toString(16)}`);
  }
  const glyphs = { '80': '4a4aea5b6adb4a53', '88': '00fe101814121010', ab: '407e7aaaba2a3a04',
    '93': '60f01f2555e55942', '94': '204e6a5b6e4ae45b', '83': '3c48fe92fe284a8e',
    '84': 'e80ef4e51ee4a4e4', '85': '88ee88fe84fd84fc', '86': '5c407e889094a6ba',
    a5: 'e90afef11feaaaf3', a6: '0eeaaaeeaaee0a12' };
  for (const [code, fingerprint] of Object.entries(glyphs)) {
    const actual = glyphRows(source, Number.parseInt(code, 16)).map(row => Number.parseInt(
      row.match(/../g).map(pixel => pixel === '##' ? '1' : '0').join(''), 2).toString(16).padStart(2, '0')).join('');
    assert.equal(actual, fingerprint, `Original kanji bitmap changed: ${code}`);
  }
  const noPointers = validateNoPointerAudit(source, result, catalog);
  return { records: catalog.entries.length, shiftJisPlayerDrafts: 5, shiftJisDiagnostics: 32,
    ...noPointers };
}

export function inventory(source) {
  const metadata = inspectRom(source);
  const characters = characterMap(source);
  const references = new Map();
  for (let pointer = 0; pointer + 4 <= source.length; pointer += 4) {
    const offset = source.readUInt32LE(pointer) - 0x08000000;
    if (offset < 0 || offset >= source.length) continue;
    if (!references.has(offset)) references.set(offset, []);
    references.get(offset).push(pointer);
  }
  const catalogs = readdirSync('translations').filter(name =>
    /^(?:full-\d+|menus|battle|overworld)\.zh-Hant\.json$/.test(name));
  const catalogEntries = catalogs.flatMap(name => JSON.parse(readFileSync(`translations/${name}`, 'utf8'))
    .entries.map(entry => ({ ...entry, catalog: name })));
  const known = new Set(catalogEntries.map(entry => Number.parseInt(entry.offset, 16)));
  const candidates = extractCandidates(source).entries;
  const extracted = new Set(candidates.map(entry => entry.offset));
  const uncovered = [];
  let tokenValidTargets = 0;
  for (const [offset, pointerOffsets] of references) {
    const end = findTextEnd(source, offset, Math.min(offset + 1024, source.length));
    if (end <= offset) continue;
    const bytes = source.subarray(offset, end);
    try { sourceTokens(bytes, characters); } catch { continue; }
    tokenValidTargets++;
    if (known.has(offset)) continue;
    const text = decodeText(bytes, characters);
    const nearby = offset >= 0x12f000 && offset < 0x169000;
    const kana = [...text.matchAll(/[\u3040-\u30ff]/gu)].length;
    const distant = bytes.length >= 12 && kana >= 6 && kana / bytes.length >= 0.5;
    if (!nearby && !distant) continue;
    uncovered.push({ offset: offset.toString(16), pointerOffsets, sourceHex: bytes.toString('hex'),
      source: text, extracted: extracted.has(offset), nearby });
  }
  uncovered.sort((left, right) => Number.parseInt(left.offset, 16) - Number.parseInt(right.offset, 16));
  return { metadata, references, characters, uncovered, catalogEntries,
    unreferenced: candidates.filter(entry => !entry.pointerOffsets.length), summary: {
    sourceSha256: metadata.sha256, romBytes: source.length,
    alignedPointerTargets: references.size, tokenValidTargets,
    extractedCandidates: candidates.length,
    extractedReferenced: candidates.filter(entry => entry.pointerOffsets.length).length,
    extractedUnreferenced: candidates.filter(entry => !entry.pointerOffsets.length).length,
    catalogOffsets: known.size,
    uncoveredNearbyTokenCandidates: uncovered.filter(entry => entry.nearby).length,
    uncoveredDistantHeuristicCandidates: uncovered.filter(entry => !entry.nearby).length,
    shiftJisCandidates: metadata.japaneseStrings.length,
    warning: 'Token-valid targets include binary data. Catalog presence is not translation acceptance. Aligned pointers do not prove renderer ownership. Unaligned, computed, compressed and image-only text remain unverified.',
  } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = readRom();
  const result = inventory(source);
  const noPointerOnly = process.argv.includes('--no-pointer-report') || process.argv.includes('--validate-no-pointer');
  if (!noPointerOnly) console.log(JSON.stringify(result.summary, null, 2));
  if (noPointerOnly) {
    const catalog = JSON.parse(readFileSync('translations/full-10.zh-Hant.json', 'utf8'));
    console.log(JSON.stringify(process.argv.includes('--no-pointer-report') ? noPointerReport(source, result, catalog) :
      validateNoPointerAudit(source, result, catalog), null, 2));
  } else if (process.argv.includes('--validate')) {
    const catalog = JSON.parse(readFileSync('translations/full-09.zh-Hant.json', 'utf8'));
    assert.equal(catalog.sourceSha256, result.metadata.sha256);
    const seen = new Set();
    for (const entry of catalog.entries) {
      assert.equal(entry.status, 'translated-draft');
      assert.ok(!seen.has(entry.offset), `Duplicate supplemental offset ${entry.offset}`);
      seen.add(entry.offset);
      try {
        validateDialogueEntry(source, entry, result.characters, { strict: true, references: result.references });
        assert.doesNotMatch(entry.translation, /[\u3040-\u30ff\uff66-\uff9f]/u);
        if (entry.source !== undefined) assert.equal(entry.source,
          decodeText(Buffer.from(entry.sourceHex, 'hex'), result.characters));
        const offset = Number.parseInt(entry.offset, 16);
        if (offset >= 0x134700 && offset < 0x135940) {
          const original = sourceTokens(Buffer.from(entry.sourceHex, 'hex'), result.characters);
          const text = original.join('');
          const price = text.match(/ +(\d+)<KANJI:8B>$/)?.[1];
          assert.ok(price, 'Shop label lacks a numeric price and currency');
          assert.equal(entry.translation.match(/ +(\d+)<KANJI:8B>$/)?.[1], price, 'Shop price changed');
          assert.equal(original.length, 16, 'Unexpected original shop column count');
          assert.equal([...entry.translation.replace('<KANJI:8B>', '$')].length, 16,
            'Shop currency column changed');
          assert.equal(entry.pointerOffsets.length, 1, 'Unexpected shop reference count');
          const pointer = entry.pointerOffsets[0];
          assert.ok((pointer >= 0x135c2c && pointer <= 0x135d28) ||
            (pointer >= 0x135d78 && pointer <= 0x135e74), 'Shop pointer is outside the reviewed table spans');
          const partnerPointer = pointer < 0x135d2c ? pointer + 0x14c : pointer - 0x14c;
          const partnerOffset = source.readUInt32LE(partnerPointer) - 0x08000000;
          const partner = catalog.entries.find(candidate => Number.parseInt(candidate.offset, 16) === partnerOffset);
          assert.ok(partner, 'Missing buy/sell partner');
          assert.equal(partner.translation.replace(/ +\d+<KANJI:8B>$/, ''),
            entry.translation.replace(/ +\d+<KANJI:8B>$/, ''), 'Buy/sell item names differ');
        }
      } catch (error) { throw new Error(`${entry.offset}: ${error.message}`, { cause: error }); }
    }
    for (let index = 0; index < 10; index++) {
      const label = index === 0 ? '初段' : index === 9 ? '免許皆傳' : `${index + 1}段`;
      for (const [base, padded] of [[0x133fb0, true], [0x167f6c, false]]) {
        const pointer = base + index * 4;
        const entry = catalog.entries.find(entry => entry.pointerOffsets.includes(pointer));
        assert.equal(entry?.translation, padded && index < 9 ? `  ${label}` : label, 'Rank label changed');
        assert.deepEqual(entry.pointerOffsets, [pointer]);
      }
    }
    assert.equal(catalog.entries.find(entry => entry.offset === '163eee')?.translation, '說明');
    console.log(`Validated ${catalog.entries.length} supplemental entries; no ROM or build artifacts written.`);
    const audit = JSON.parse(readFileSync('translations/full-10.zh-Hant.json', 'utf8'));
    console.log(JSON.stringify(validateSupplementalAudit(source, result, audit), null, 2));
  } else if (process.argv.includes('--shift-jis')) {
    console.log(JSON.stringify(result.metadata.japaneseStrings.map(entry => ({ ...entry,
      sourceEncoding: 'shift_jis', sourceHex: source.subarray(entry.offset,
        source.indexOf(0, entry.offset)).toString('hex'),
      endOffset: source.indexOf(0, entry.offset).toString(16),
    })), null, 2));
  } else if (process.argv.includes('--unreferenced')) {
    const audit = classifyUnreferenced(source, result);
    console.log(JSON.stringify(process.argv.includes('--summary') ? { ...audit, entries: undefined } : audit, null, 2));
  } else if (process.argv.includes('--glyphs')) {
    for (const code of process.argv.slice(process.argv.indexOf('--glyphs') + 1)) {
      console.log(`${code}\n${glyphRows(source, Number.parseInt(code, 16)).join('\n')}`);
    }
  } else if (!process.argv.includes('--summary')) {
    console.log(JSON.stringify(result.uncovered, null, 2));
  }
}