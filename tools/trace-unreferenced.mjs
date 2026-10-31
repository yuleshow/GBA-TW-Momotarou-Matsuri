import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inspectRom, readRom } from './inspect-rom.mjs';
import { inspectTextPointerResources } from './audit-text-pointers.mjs';
import { characterMap, decodeText, findTextEnd } from './extract-text.mjs';

const rom = readRom(process.argv[2]);
const metadata = inspectRom(rom);
const resources = inspectTextPointerResources(rom);
const catalog = JSON.parse(readFileSync(new URL('../translations/full-10.zh-Hant.json', import.meta.url)));
assert.equal(catalog.sourceSha256, metadata.sha256);
const targets = [0x130052, 0x130326, 0x1303f0, 0x13040e, 0x13042d, 0x163f6b,
  0x13634c, 0x136376, 0x163abd, 0x1646c3];
const positions = [0x248955, 0x30a3e0, 0x128af1, 0x128fe8, 0x12db34, 0x16b845, 0x39e572];
const hex = value => `${value < 0 ? '-' : ''}0x${Math.abs(value).toString(16)}`;
const characters = characterMap(rom);
const text = targets.map(offset => {
  const entry = catalog.entries.find(candidate => Number.parseInt(candidate.offset, 16) === offset);
  assert.ok(entry);
  const end = offset + entry.sourceHex.length / 2;
  assert.equal(rom.subarray(offset, end).toString('hex'), entry.sourceHex);
  assert.equal(findTextEnd(rom, offset, end + 1), end);
  assert.equal(rom[end], 0);
  assert.equal(decodeText(rom.subarray(offset, end), characters), entry.source);
  return { offset: hex(offset), nul: hex(end), bytes: end - offset, source: entry.source,
    status: entry.status };
});

const arithmetic = positions.map(position => {
  const interpretations = [];
  const matches = [];
  for (const width of [2, 3, 4]) {
    for (const endian of ['LE', 'BE']) {
      const unsigned = rom[`readUInt${endian}`](position, width);
      const signed = rom[`readInt${endian}`](position, width);
      interpretations.push({ width, endian, unsigned: hex(unsigned), signed });
      for (const [sign, displacement] of [['unsigned', unsigned], ['signed', signed]]) {
        for (const base of [0, position, position + 2, position + 3, position + 4, position + 8]) {
          if (targets.includes(base + displacement)) matches.push({ width, endian, sign,
            base: hex(base), displacement, target: hex(base + displacement) });
        }
      }
    }
  }
  assert.ok(matches.length, `Candidate arithmetic not reproduced: ${hex(position)}`);
  return { position: hex(position), bytes: rom.subarray(position, position + 4).toString('hex'),
    interpretations, matches, verifiedContainers: resources.containers(position).map(span => hex(span.header)) };
});

function traceTrack(songEntry, trackIndex, candidates) {
  assert.ok(songEntry >= 0x514d0 && songEntry < 0x51968 && (songEntry - 0x514d0) % 8 === 0);
  const song = rom.readUInt32LE(songEntry) - 0x08000000;
  assert.ok(trackIndex < rom[song]);
  const pointer = song + 8 + trackIndex * 4;
  const start = rom.readUInt32LE(pointer) - 0x08000000;
  const events = [];
  const returns = [];
  let cursor = start;
  let running;
  let terminated = false;
  while (cursor < song && events.length < 10000) {
    const eventStart = cursor;
    const byte = rom[cursor];
    const explicit = byte >= 0x80;
    const opcode = explicit ? rom[cursor++] : running;
    assert.ok(opcode !== undefined, `No running status at ${hex(eventStart)}`);
    if (explicit && opcode >= 0xbd) running = opcode;
    let kind;
    let next;
    if (opcode >= 0x80 && opcode <= 0xb0) kind = 'wait';
    else if (opcode === 0xb1) {
      kind = 'fine';
      terminated = true;
    } else if (opcode === 0xb2) {
      kind = 'goto';
      const destination = rom.readUInt32LE(cursor) - 0x08000000;
      assert.ok(events.some(event => event.start === destination), 'Loop must target a parsed boundary');
      cursor += 4;
      terminated = true;
    } else if (opcode === 0xb3) {
      kind = 'pattern-call';
      next = rom.readUInt32LE(cursor) - 0x08000000;
      cursor += 4;
      assert.ok(next >= start && next < song);
      assert.ok(returns.length < 3);
      returns.push(cursor);
    } else if (opcode === 0xb4) {
      kind = 'pattern-end';
      next = returns.pop();
    } else if (opcode >= 0xcf) {
      kind = opcode === 0xcf ? 'tie' : 'note';
      for (let operand = 0; operand < (opcode === 0xcf ? 2 : 3) && rom[cursor] < 0x80; operand++) cursor++;
    } else if ([0xba, 0xbb, 0xbc, 0xbd, 0xbe, 0xbf, 0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc8].includes(opcode)) {
      kind = { 0xbc: 'keyshift', 0xbd: 'voice', 0xbe: 'volume', 0xbf: 'pan', 0xc0: 'bend',
        0xc2: 'lfo-speed', 0xc3: 'lfo-delay', 0xc4: 'modulation' }[opcode] ?? 'one-byte-command';
      cursor++;
    } else {
      assert.fail(`Unsupported track opcode ${hex(opcode)} at ${hex(eventStart)}`);
    }
    assert.ok(cursor <= song);
    events.push({ start: eventStart, end: cursor, opcode, kind, explicit,
      bytes: rom.subarray(eventStart, cursor).toString('hex') });
    if (next !== undefined) cursor = next;
    if (terminated) break;
  }
  assert.ok(terminated, 'Track walk must reach FINE or a verified backward GOTO');
  const hits = candidates.map(candidate => {
    const intersecting = events.filter(event => candidate < event.end && candidate + 2 > event.start);
    assert.ok(intersecting.some(event => event.start <= candidate && event.end > candidate));
    assert.ok(intersecting.some(event => event.start <= candidate + 1 && event.end > candidate + 1));
    assert.ok(intersecting.every(event => ['wait', 'note', 'bend'].includes(event.kind)));
    return { position: hex(candidate), events: intersecting.map(event => ({ ...event,
      start: hex(event.start), end: hex(event.end), opcode: hex(event.opcode) })) };
  });
  return { songEntry: hex(songEntry), song: hex(song), trackIndex, pointer: hex(pointer),
    start: hex(start), end: hex(cursor), events: events.length, hits };
}

const music = [traceTrack(0x518c8, 1, [0x128af1]), traceTrack(0x518c8, 2, [0x128fe8]),
  traceTrack(0x51930, 2, [0x12db34])];
const decodedCandidates = positions.flatMap(position => resources.spans
  .filter(span => position >= span.header && position < span.end && span.kind !== 'pcm')
  .map(span => {
    const decoded = resources.decodeResource(rom, span.header);
    assert.equal(span.header + decoded.consumed, span.end);
    assert.equal(decoded.data.length, span.decodedBytes);
    return { position: hex(position), header: hex(span.header), end: hex(span.end),
      kind: span.kind, consumed: decoded.consumed, decodedBytes: decoded.data.length,
      verified: resources.verifiedSpans.includes(span) };
  }));

function decodeRawWordLz(start, candidate) {
  assert.equal(rom[start], 0xe0);
  const size = rom.readUIntLE(start + 1, 3);
  assert.ok(size > 0 && size <= 0x100000 && size % 2 === 0);
  const output = Buffer.alloc(size);
  const dictionary = new Uint16Array(1024);
  const tokens = [];
  let ring = 0x3be;
  let cursor = start + 4;
  let written = 0;
  while (written < size) {
    const flagOffset = cursor;
    const flags = rom[cursor++];
    if (candidate <= flagOffset && candidate + 3 > flagOffset) tokens.push({
      offset: hex(flagOffset), kind: 'flag-byte', value: hex(flags) });
    for (let bit = 0; bit < 8 && written < size; bit++) {
      const tokenOffset = cursor;
      const token = rom.readUInt16LE(cursor);
      cursor += 2;
      let index = token >>> 6;
      const copied = Boolean(flags & (1 << bit));
      const count = copied ? (token & 63) + 3 : 1;
      const outputStart = written;
      for (let repeat = 0; repeat < count; repeat++) {
        const value = copied ? dictionary[index++ & 1023] : token;
        output.writeUInt16LE(value, written);
        written += 2;
        dictionary[ring++ & 1023] = value;
      }
      if (candidate < cursor && candidate + 3 > tokenOffset) tokens.push({
        offset: hex(tokenOffset), flagOffset: hex(flagOffset), flags: hex(flags), bit,
        token: hex(token), kind: copied ? 'dictionary-copy' : 'literal-halfword',
        outputStart: hex(outputStart), outputEnd: hex(written) });
    }
  }
  assert.equal(written, size);
  assert.ok(candidate >= start + 4 && candidate + 3 <= cursor);
  return { header: hex(start), end: hex(cursor), consumed: cursor - start,
    decodedBytes: size, tokens };
}

function expectBytes(offset, expected) {
  assert.equal(rom.subarray(offset, offset + expected.length / 2).toString('hex'), expected,
    `Consumer instructions changed at ${hex(offset)}`);
}

assert.equal(rom.readUInt32LE(0x15160), 0x0804c018);
assert.equal(0x4c018 + 12 + 4, 0x4c028);
assert.equal(rom.readUInt32LE(0x4c028), 0x08248920);
expectBytes(0x1504e, '2178480040188000043540190068391cf7f719fc');
expectBytes(0xc950, '281c311cfff720ff');
const wordLz = decodeRawWordLz(0x248920, 0x248955);
assert.equal(wordLz.end, '0x2489c2');
assert.equal(wordLz.decodedBytes, 0x500);

assert.equal(rom.readUInt32LE(0x41fc), 0x08131664);
assert.equal(0x131664 + 2 * 36 + 4, 0x1316b0);
assert.equal(rom.readUInt32LE(0x1316b0), 0x2a30);
assert.equal(rom.readUInt32LE(0x168744), 0x08168aec);
assert.equal(rom.readUInt32LE(0x168744) - 0x08000000 + rom.readUInt32LE(0x1316b0), 0x16b51c);
expectBytes(0x43ec8, '0006034a800d8018006840187047');
expectBytes(0x4194, '4246516800203ff095fe');
expectBytes(0x41ac, '201c059908f070fb');
const pairSpan = resources.spans.find(span => span.header === 0x16b51c);
assert.ok(pairSpan && pairSpan.header <= 0x16b845 && pairSpan.end > 0x16b846);

assert.equal(rom.readUInt32LE(0x3a258), 0x0813f378);
assert.equal(rom.readUInt32LE(0x13f380), 0x08305314);
assert.equal(rom[0x305314], 0xf0);
const rawSize = rom.readUIntLE(0x305315, 3);
assert.equal(rawSize, 0x60d6);
assert.ok(0x30a3e0 >= 0x305318 && 0x30a3e4 <= 0x305318 + rawSize);
expectBytes(0xc95a, '9202d20a281c311c3af0a3fb');
expectBytes(0x470ac, '0bdf7047');
expectBytes(0x30e2, '2868806804300590');
expectBytes(0x3162, '910089184900059a89184f783a0208780243');
assert.equal(rawSize % 10, 0);
assert.equal((0x30a3e0 - 0x305318) % 10, 0);
expectBytes(0x47cb8, '2a6c1178802901d2e97904e001322a64bd2900d3e971cf29');
expectBytes(0x48774, 'b100381c0830401800682064');
const stageMapHeader = 0x39b878;
const stageMapStart = stageMapHeader + 4;
const stageMapSize = rom.readUIntLE(stageMapHeader + 1, 3);
assert.equal(rom[stageMapHeader], 0xf0);
assert.equal(stageMapSize, 0x42fe);
assert.equal(stageMapSize % 10, 0);
assert.equal((0x39e572 - stageMapStart) % 10, 0);
assert.ok(0x39e572 + 10 <= stageMapStart + stageMapSize);
assert.equal(0x39e572 + rom.readIntLE(0x39e572, 3), 0x1646c3);
for (const pointer of [0x13f8d8, 0x13f920, 0x13f968, 0x13f9b0]) {
  assert.equal((pointer - 0x13f378 - 8) % 72, 0);
  assert.equal(rom.readUInt32LE(pointer), stageMapHeader + 0x08000000);
}
const resourceEvidence = [
  { position: '0x39e572', kind: 'raw-halfwords', header: hex(stageMapHeader), start: hex(stageMapStart),
    end: hex(stageMapStart + stageMapSize), decodedBytes: stageMapSize,
    tablePointers: ['0x13f8d8', '0x13f920', '0x13f968', '0x13f9b0'],
    recordIndex: (0x39e572 - stageMapStart) / 10, recordBytes: 10, recordCount: stageMapSize / 10,
    candidateRecord: rom.subarray(0x39e572, 0x39e57c).toString('hex'),
    consumer: 'Same verified 72-byte map table and record+8 consumer at0x30e2; ten-byte tile records indexed at0x3162. Three raw tile bytes accidentally satisfy a signed relative24 equation.',
    fieldConsumerVerified: true, naturalSelectionVerified: false },
  { position: '0x248955', kind: 'raw-word-lz', ...wordLz,
    table: '0x4c018 + index * 12 + 4, index=1 -> 0x4c028 -> 0x248920',
    consumer: '0x1504e..0x1505e -> 0xc894 -> 0xc950 -> 0xc798; destination 0x0600b800' },
  { position: '0x16b845', kind: 'pairs', header: hex(pairSpan.header), end: hex(pairSpan.end),
    decodedBytes: pairSpan.decodedBytes, table: '0x131664 + 2 * 36 + 4 = 0x1316b0',
    equation: 'LE32[0x168744] - 0x08000000 + LE32[0x1316b0] = 0x168aec + 0x2a30 = 0x16b51c',
    lookup: '0x43ec8', fieldConsumerVerified: true,
    consumer: '0x4172..0x417e selects 36-byte record; conditional +4 load at 0x4196 -> 0x419a resource lookup bank 0 -> 0x41b0 decoder 0xc894 -> 0xc91e pair decoder 0x3fb0',
    naturalSelectionVerified: false },
  { position: '0x30a3e0', kind: 'raw-halfwords', header: '0x305314', start: '0x305318',
    end: hex(0x305318 + rawSize), decodedBytes: rawSize,
    table: '0x13f378 + 8 = 0x13f380 -> 0x305314',
    halfwords: [rom.readUInt16LE(0x30a3e0), rom.readUInt16LE(0x30a3e2)].map(hex),
    recordIndex: (0x30a3e0 - 0x305318) / 10, recordBytes: 10, recordCount: rawSize / 10,
    candidateRecord: rom.subarray(0x30a3e0, 0x30a3ea).toString('hex'),
    consumer: '0x3a238..0x3a24a selects 72-byte map record -> 0x39b80 calls 0x3064; 0x30e2..0x30e8 loads record+8 and skips header; 0x3162..0x316a indexes block*10; 0x316c..0x3196 copies four tile halfwords to the screen buffer',
    genericFormatHandler: 'F0 dispatch 0xc95a -> 0x470ac BIOS CpuSet; not the direct map path',
    fieldConsumerVerified: true, naturalSelectionVerified: false },
];

console.log(JSON.stringify({ sourceSha256: metadata.sha256, followupOwnerTrace: catalog.audit.followupOwnerTrace,
  text, arithmetic, music, decodedCandidates, resourceEvidence,
  musicConsumer: '0x48368 indexes song table by 8 -> 0x48720; 0x48774..0x4877e loads header+8+track*4 into track+0x40. 0x47cb8..0x47d0e reads byte opcodes, retains running status >=BD, dispatches notes >=CF and waits 80..B0.',
  result: { candidatesExplained: positions.length, textOwnersFound: 0, insertionSitesFound: 0,
    remainingUnreferencedDrafts: 17, globalUnreachabilityProven: false },
  limits: 'Read-only focused trace. Arithmetic equality is not a text reference. Track parsing rejects unsupported commands. No natural gameplay, build, relocation or proof of global unreachability.' }, null, 2));