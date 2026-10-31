import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extractCandidates } from './extract-text.mjs';
import { readRom } from './inspect-rom.mjs';

const source = readRom();
const catalog = extractCandidates(source);
const existing = ['menus', 'battle', 'overworld'].flatMap(name =>
  JSON.parse(readFileSync(`translations/${name}.zh-Hant.json`)).entries);
const known = new Set(existing.map(entry => Number.parseInt(entry.offset, 16)));
const entries = catalog.entries.filter(entry => entry.pointerOffsets.length && !known.has(entry.offset));
const shards = Array.from({ length: 8 }, () => []);
const weights = Array(8).fill(0);
for (const entry of entries) {
  const shard = weights.indexOf(Math.min(...weights));
  const end = entry.offset + entry.byteLength;
  assert.equal(source.subarray(entry.offset, end).toString('hex'), entry.rawHex);
  shards[shard].push({ offset: entry.id, pointerOffsets: entry.pointerOffsets, sourceHex: entry.rawHex,
    source: entry.source, boundaryMethod: entry.boundaryMethod, translation: '', status: 'needs-review' });
  weights[shard] += entry.source.length;
}
mkdirSync('build/full-translation', { recursive: true });
for (const [index, entries] of shards.entries()) {
  writeFileSync(`build/full-translation/source-${index + 1}.json`, JSON.stringify({
    sourceSha256: catalog.sourceSha256, language: 'zh-Hant', warning: catalog.warning, entries,
  }, null, 2) + '\n');
}
console.log(JSON.stringify({ candidates: catalog.entries.length, remainingReferenced: entries.length,
  shards: shards.map((entries, index) => ({ id: index + 1, records: entries.length, sourceCharacters: weights[index] })),
}, null, 2));