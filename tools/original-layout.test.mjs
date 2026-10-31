import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { applyPrototypeIps, translationFont } from './build-prototype.mjs';
import { assertPreservedRom, encodeDialogue, thumbCall } from './build-dialogue.mjs';
import { filterTextPointers } from './audit-text-pointers.mjs';
import { decodePairs } from './font.mjs';
import { readRom } from './inspect-rom.mjs';

test('original-layout Chinese preserves Japanese glyphs, windows, controls and gameplay', () => {
  const prefix = 'build/momotarou-zh-Hant';
  const source = readRom();
  const rom = readFileSync(`${prefix}.gba`);
  const manifest = JSON.parse(readFileSync(`${prefix}.json`));
  const base = JSON.parse(readFileSync('build/momotarou-zh-Hant-menu-prototype.json'));
  const characters = JSON.parse(readFileSync('build/dialogue-characters.json'));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const full = manifest.fullCorpus !== undefined;
  const scene = process.env.GBA_TEST_SCENE;
  assert.ok(scene === undefined || ['grandparents', 'full-smoke', 'battle-status'].includes(scene), `Unknown scene: ${scene}`);
  if (scene === 'full-smoke') assert.ok(full, 'full-smoke requires a rebuilt full-corpus ROM');
  assert.equal(hash(source), manifest.sourceSha256);
  assert.equal(rom.readUInt32LE(0x3ce044), source.readUInt32LE(0x3ce044),
    'Compressed graphics must not be mistaken for a pointer to text 14aaab');
  assert.equal(rom.length, full ? 0x800000 : source.length);
  if (full) {
    assert.equal(source.length, 0x400000);
    assert.equal(manifest.sourceSize, source.length);
    assert.equal(manifest.outputSize, 0x800000);
    assert.equal(manifest.fullCorpus.entries, manifest.translated.length);
    assert.deepEqual(manifest.fullCorpus.errors, []);
    assert.ok(!manifest.translated.some(entry => entry.offset === '14aaab'));
    assert.ok(manifest.fullCorpus.blocked.some(entry => entry.offset === '14aaab' &&
      entry.status === 'non-text-reference-not-installed'));
    const mixed = manifest.translated.find(entry => entry.offset === '131208');
    assert.ok(mixed, '131208 must retain its real text pointer');
    assert.deepEqual(mixed.sourcePointerOffsets, [0x100894, 0x131fa0]);
    assert.deepEqual(mixed.pointerOffsets, [0x131fa0]);
    assert.deepEqual(mixed.rejectedPointerOffsets, [0x100894]);
    assert.equal(rom.readUInt32LE(0x100894), source.readUInt32LE(0x100894));
    assert.ok(manifest.fullCorpus.filtered.some(entry => entry.offset === '131208' &&
      entry.status === 'translated-with-filtered-references'));
    assert.equal(manifest.baseTranslationCount, 0);
    assert.deepEqual(manifest.baseAllocations, base.allocations);
  }
  assert.ok(Number.isInteger(manifest.dynamicGlyphCount) && manifest.dynamicGlyphCount > 0 &&
    manifest.dynamicGlyphCount <= 4096);
  assert.equal(characters.length, manifest.dynamicGlyphCount);
  assert.equal(new Set(characters).size, characters.length);
  assert.equal(manifest.font.name, 'Fusion Pixel 8px Traditional Chinese');
  assert.equal(manifest.font.pointSize, 8);
  assert.equal(hash(readFileSync(translationFont.path)), manifest.font.sha256);
  assert.equal(hash(rom), manifest.outputSha256);
  assert.deepEqual(applyPrototypeIps(source, readFileSync(`${prefix}.ips`)), rom);
  assert.equal(manifest.largeText, undefined);
  assert.equal(manifest.layoutPatches, undefined);
  assert.equal(manifest.cacheSlots, 64);
  assert.deepEqual(manifest.hooks.map(hook => hook.offset), [0x3d418, 0x3d2ac]);
  const originalFont = decodePairs(source, 0x2f8ecc).data;
  const originalKanji = decodePairs(source, 0x2f9878).data;
  assert.deepEqual(decodePairs(rom, base.fontOffset).data.subarray(0, 0x2000), originalFont);
  const allowed = Buffer.alloc(rom.length);
  allowed.fill(1, 0x46a7c, 0x46a80);
  const allocations = [...base.allocations, ...manifest.allocations].sort((left, right) => left.offset - right.offset);
  let allocationEnd = 0;
  for (const allocation of allocations) {
    assert.ok(Number.isInteger(allocation.offset) && Number.isInteger(allocation.size) &&
      allocation.offset >= allocationEnd && allocation.size > 0 &&
      allocation.offset + allocation.size <= rom.length, `Invalid or overlapping allocation: ${allocation.label}`);
    allocationEnd = allocation.offset + allocation.size;
    assert.ok(source.subarray(allocation.offset, Math.min(allocationEnd, source.length)).every(byte => byte === 0xff),
      `Allocation overwrites original data: ${allocation.label}`);
    allowed.fill(1, allocation.offset, allocation.offset + allocation.size);
  }
  const allocationFor = label => {
    const matches = manifest.allocations.filter(allocation => allocation.label === label);
    assert.equal(matches.length, 1, `Expected one allocation: ${label}`);
    return matches[0];
  };
  const count = allocationFor('dynamic-glyph-count');
  const library = allocationFor('dynamic-glyph-library');
  const code = allocationFor('dynamic-glyph-code');
  assert.equal(count.size, 4);
  assert.equal(rom.readUInt32LE(count.offset), manifest.dynamicGlyphCount);
  assert.equal(library.offset, manifest.tilesOffset);
  assert.equal(library.size, characters.length * 32);
  assert.equal(code.offset, manifest.codeOffset);
  assert.ok(code.offset + code.size <= source.length, 'Thumb code must remain in original ROM padding');
  if (full) {
    for (const allocation of manifest.allocations) {
      if (allocation !== code) assert.ok(allocation.offset >= source.length, `Data not appended: ${allocation.label}`);
    }
  }
  for (const hook of manifest.hooks) {
    assert.ok(Number.isInteger(hook.offset) && hook.offset >= 0xc0 && hook.offset + 4 <= source.length &&
      hook.offset % 2 === 0);
    assert.ok(Number.isInteger(hook.target) && hook.target >= code.offset && hook.target + 2 <= code.offset + code.size &&
      hook.target % 2 === 0);
    const distance = hook.target - hook.offset - 4;
    assert.ok(distance >= -0x400000 && distance <= 0x3ffffe, 'Hook exceeds Thumb BL range');
    allowed.fill(1, hook.offset, hook.offset + 4);
    assert.deepEqual(rom.subarray(hook.offset, hook.offset + 4), thumbCall(hook.offset, hook.target));
  }
  const references = new Map();
  const excluded = manifest.fullCorpus?.blocked.filter(entry => entry.status === 'non-text-reference-not-installed') ?? [];
  for (const entry of [...base.translated, ...manifest.translated, ...excluded]) references.set(Number.parseInt(entry.offset, 16), []);
  for (let offset = 0; offset + 4 <= source.length; offset += 4) {
    references.get(source.readUInt32LE(offset) - 0x08000000)?.push(offset);
  }
  const pointerTargets = new Map();
  for (const entry of [...base.translated, ...manifest.translated]) {
    const sourceOffset = Number.parseInt(entry.offset, 16);
    assert.ok(entry.pointerOffsets.length > 0, `No declared pointers: ${entry.offset}`);
    const evidence = filterTextPointers(source, references.get(sourceOffset));
    assert.deepEqual(entry.sourcePointerOffsets ?? entry.pointerOffsets, evidence.sourcePointerOffsets,
      `Incomplete source pointer inventory: ${entry.offset}`);
    assert.deepEqual(entry.pointerOffsets, evidence.pointerOffsets, `Incorrect installed pointer inventory: ${entry.offset}`);
    if (full && manifest.translated.includes(entry)) {
      assert.deepEqual(entry.sourcePointerOffsets, evidence.sourcePointerOffsets);
      assert.deepEqual(entry.rejectedPointerOffsets, evidence.rejectedPointerOffsets);
    }
    for (const pointer of entry.pointerOffsets) {
      allowed.fill(1, pointer, pointer + 4);
      pointerTargets.set(pointer, entry.targetOffset);
    }
  }
  for (const entry of excluded) {
    const evidence = filterTextPointers(source, references.get(Number.parseInt(entry.offset, 16)));
    assert.deepEqual(entry.sourcePointerOffsets, evidence.sourcePointerOffsets);
    assert.deepEqual(entry.pointerOffsets, []);
    assert.deepEqual(evidence.pointerOffsets, []);
    assert.deepEqual(entry.rejectedPointerOffsets, evidence.rejectedPointerOffsets);
    assert.ok(!manifest.translated.some(translated => translated.offset === entry.offset));
  }
  assertPreservedRom(source, rom, { allocations, hooks: manifest.hooks, pointers: [0x46a7c, ...pointerTargets.keys()] });
  for (const [pointer, target] of pointerTargets) {
    assert.equal(rom.readUInt32LE(pointer), 0x08000000 + target, `Wrong pointer at ${pointer.toString(16)}`);
  }
  assert.equal(rom.readUInt32LE(0x46a7c), 0x08000000 + base.fontOffset);
  assert.equal(new Set(manifest.translated.map(entry => entry.offset)).size, manifest.translated.length);
  for (const entry of manifest.translated) {
    const encoded = encodeDialogue(entry.translation, characters);
    const allocation = allocationFor(entry.offset);
    assert.equal(allocation.offset, entry.targetOffset);
    assert.equal(allocation.size, encoded.length);
    assert.deepEqual(rom.subarray(entry.targetOffset, entry.targetOffset + encoded.length), encoded);
    const sourceOffset = Number.parseInt(entry.offset, 16);
    const sourceBytes = Buffer.from(entry.sourceHex, 'hex');
    assert.deepEqual(source.subarray(sourceOffset, sourceOffset + sourceBytes.length), sourceBytes);
    assert.equal(source[sourceOffset + sourceBytes.length], 0);
    assert.deepEqual(rom.subarray(sourceOffset, sourceOffset + sourceBytes.length + 1),
      source.subarray(sourceOffset, sourceOffset + sourceBytes.length + 1), `Original text changed: ${entry.offset}`);
    for (const pointer of entry.pointerOffsets) assert.equal(rom.readUInt32LE(pointer), 0x08000000 + entry.targetOffset);
  }
  for (let offset = 0; offset < rom.length; offset++) {
    const expected = offset < source.length ? source[offset] : 0xff;
    if (expected !== rom[offset]) assert.equal(allowed[offset], 1, `Unexpected ROM change or non-FF gap ${offset.toString(16)}`);
  }
  const licenses = readFileSync(`${prefix}-font-licenses.txt`, 'utf8');
  for (const name of ['Fusion Pixel', 'boutique-bitmap-7x7', 'galmuri', 'misaki', 'miseki-bitmap']) {
    assert.ok(licenses.includes(name));
  }
  assert.ok(!licenses.includes('Silver'));
  const captureDirectory = mkdtempSync('build/original-layout-');
  const capturePath = name => join(captureDirectory, name);
  console.log(`Runtime captures: ${captureDirectory}`);
  const capture = (name, steps) => {
    console.log(`Checking ${name}`);
    execFileSync('build/capture', [`${prefix}.gba`, capturePath(name), ...steps], { stdio: 'ignore' });
    const vram = readFileSync(capturePath(`${name}.vram`));
    assert.deepEqual(vram.subarray(0xc000, 0xe000), originalFont);
    assert.deepEqual(vram.subarray(0xf000, 0xf000 + originalKanji.length), originalKanji);
    return vram;
  };
  const assertText = (vram, text) => {
    const matches = [];
    for (let row = 0; row < 20; row++) {
      for (let column = 0; column + [...text].length <= 30; column++) {
        if ([...text].every((character, index) => {
          const glyph = characters.indexOf(character);
          assert.ok(glyph >= 0, `Unknown character ${character}`);
          const tile = vram.readUInt16LE(0xf800 + (row * 32 + column + index) * 2) & 0x3ff;
          return tile >= 0x100 && tile < 0x140 &&
            vram.subarray(0xc000 + tile * 32, 0xc000 + (tile + 1) * 32)
              .equals(rom.subarray(manifest.tilesOffset + glyph * 32, manifest.tilesOffset + (glyph + 1) * 32));
        })) matches.push({ row, column });
      }
    }
    assert.equal(matches.length, 1, `Expected one visible 8px string: ${text}`);
    return matches[0];
  };
  const start = ['900:0', '2:8', '180:0', '2:8', '180:0'];
  assertText(capture('original-start', start), '開始遊戲');
  const opening = [...start, '2:1', '1500:0'];
  if (full) {
    const statusView = capture('original-battle-status', opening);
    const iwram = readFileSync(capturePath('original-battle-status.iwram'));
    const tileAt = (column, row) => statusView.readUInt16LE(0xf800 + (row * 32 + column) * 2) & 0x3ff;
    for (let index = 0; index < 4; index++) {
      const column = 2 + index * 7;
      const nameOffset = source.readUInt32LE(0x1685d8 + index * 4) - 0x08000000;
      for (let offset = nameOffset, character = 0; source[offset] !== 0; offset += 2, character++) {
        assert.equal(source[offset], 5, 'Battle names use original kanji tokens');
        assert.equal(tileAt(column + character, 1), source[offset + 1] + 0x100,
          `Missing battle name ${index + 1}, character ${character + 1}`);
      }
      for (const [row, label, valueOffset] of [[2, 'HP', 4], [3, 'MP', 6]]) {
        const value = iwram.readUInt16LE(0x228 + index * 8 + valueOffset);
        const text = label + String(value).padStart(3, ' ');
        for (const [character, glyph] of [...text].entries()) {
          const tile = tileAt(column + character, row);
          if (character < label.length) {
            const glyphIndex = characters.indexOf(glyph);
            assert.ok(glyphIndex >= 0 && tile >= 0x100 && tile < 0x140);
            assert.deepEqual(statusView.subarray(0xc000 + tile * 32, 0xc000 + (tile + 1) * 32),
              rom.subarray(manifest.tilesOffset + glyphIndex * 32, manifest.tilesOffset + (glyphIndex + 1) * 32),
              `Wrong battle label ${index + 1}: ${label}`);
          } else {
            assert.equal(tile, glyph.charCodeAt(0),
              `Wrapped or missing battle value ${index + 1}: ${text}`);
          }
        }
      }
    }
  }
  if (scene === 'battle-status') {
    assert.ok(full, 'battle-status requires a rebuilt full-corpus ROM');
    assert.deepEqual(readFileSync(`${prefix}.gba`), rom);
    return;
  }
  const grandparents = [...opening, ...Array.from({ length: 100 }, () => ['2:1', '90:0']).flat(), '240:0'];
  for (const [index, text] of [
    '邀請你去參加祭典呢', '遊戲攤位都擺出來了', '如今才能舉辦祭典啊', '好好玩個痛快吧',
    '鬼族也都安分下來了', '盡情放鬆一下吧', '帶上黍米糰子再出發吧',
  ].entries()) {
    const steps = [...grandparents, ...Array.from({ length: index }, () => ['2:1', '240:0']).flat()];
    assertText(capture(`original-grandparents-${index + 1}`, steps), text);
    assert.equal(readFileSync(capturePath(`original-grandparents-${index + 1}.iwram`)).readUInt32LE(0x80), 0x08155ddc);
  }
  const afterGrandparents = [...grandparents, ...Array.from({ length: 7 }, () => ['2:1', '240:0']).flat()];
  capture('original-grandparents-exit', afterGrandparents);
  assert.notEqual(readFileSync(capturePath('original-grandparents-exit.iwram')).readUInt32LE(0x80), 0x08155ddc);
  if (scene === 'grandparents') {
    assert.deepEqual(readFileSync(`${prefix}.gba`), rom);
    return;
  }
  const battle = capture('original-battle', opening);
  for (const [index, text] of ['戰鬥', '術法', '道具', '防禦'].entries()) {
    assert.deepEqual(assertText(battle, text), { column: 3, row: 5 + index });
  }
  const itemSteps = [...opening, '2:128', '15:0', '2:128', '15:0', '2:1', '90:0'];
  const items = capture('original-items', itemSteps);
  for (const text of ['仙金丹糖', '恆河沙珠', '閃電珠', '恢復一名我方', '角色的體力']) assertText(items, text);
  const returned = capture('original-menu-return', [...itemSteps, '2:2', '60:0', '2:128', '60:0']);
  const cursor = returned.readUInt16LE(0xf800 + (8 * 32 + 2) * 2) & 0x3ff;
  assert.ok(cursor >= 0x22 && cursor <= 0x25);
  if (scene === 'full-smoke') {
    assert.deepEqual(readFileSync(`${prefix}.gba`), rom);
    return;
  }
  const closing = manifest.translated.find(entry => entry.offset === '1683e2');
  const redirect = `patch32:804227c:${rom.readUInt32LE(0x4227c).toString(16)}:${(0x08000000 + closing.targetOffset).toString(16)}`;
  assertText(capture('original-closing', [...opening, redirect, '2:1', '240:0']), '還有');
  assertText(capture('original-closing-next', [...opening, redirect, '2:1', '240:0', '2:1', '240:0']), '我的女兒');
  assertText(capture('original-damage', [...opening, '2:1', '120:0', '2:1', '240:0', '2:1', '240:0']), '點傷害');
  for (const [offset, page, highlight, normal, lastPage, lastText, middlePages = []] of [
    ['15d6c0', 1, '儲存', '就行了', 2, '跑回這裡來喔'],
    ['15d7c7', 0, '指令選單', '嗎', 0, '想知道如何開啟'],
    ['15d7e9', 0, '開始鍵', '就行囉', 0, '要開啟'],
    ['15d940', 0, '狀態', '畫面吧', 1, '都能在這裡欣賞喔'],
    ['15d982', 0, '步數', '嗎', 3, '真令人期待啊'],
    ['15da01', 0, '桃子圖案', '啊', 4, '精通遊戲之道吧', [
      ['表示', '目前的成長程度'], ['即使是', '在遊戲的世界裡'], ['也還只是顆桃子', '就是這個意思'],
    ]],
    ['15da9d', 0, '嬰兒圖案', '啊', 4, '精通遊戲之道吧', [
      ['表示', '目前的成長程度'], ['即使是', '在遊戲的世界裡'], ['也和嬰兒沒兩樣', '就是這個意思'],
    ]],
    ['15db3c', 0, '孩童圖案', '啊', 4, '精通遊戲之道吧', [
      ['表示', '目前的成長程度'], ['即使是', '在遊戲的世界裡'], ['也還只是個孩子', '就是這個意思'],
    ]],
    ['15dbd9', 0, '圖案', '啊', 4, '鑽研遊戲之道啊', [
      ['表示', '目前的成長程度'], ['遊戲的世界裡'], ['也能獨當一面了', '就是這個意思'],
    ]],
  ]) {
    const entry = manifest.translated.find(record => record.offset === offset);
    const patch = `patch32:804227c:${rom.readUInt32LE(0x4227c).toString(16)}:${(0x08000000 + entry.targetOffset).toString(16)}`;
    const steps = [...opening, patch, '2:1', '240:0'];
    const advance = count => Array.from({ length: count }, () => ['2:1', '240:0']).flat();
    const view = capture(`original-tutorial-${offset}`, [...steps, ...advance(page)]);
    for (const [text, palette] of [[highlight, 14], [normal, 15]]) {
      const location = assertText(view, text);
      for (let index = 0; index < [...text].length; index++) {
        assert.equal(view.readUInt16LE(0xf800 + (location.row * 32 + location.column + index) * 2) >> 12, palette,
          `Wrong text palette for ${text}`);
      }
    }
    assertText(lastPage === page ? view : capture(`original-tutorial-${offset}-last`, [...steps, ...advance(lastPage)]), lastText);
    for (const [index, texts] of middlePages.entries()) {
      const middle = capture(`original-tutorial-${offset}-page-${index + 2}`, [...steps, ...advance(index + 1)]);
      for (const text of texts) assertText(middle, text);
    }
    const after = capture(`original-tutorial-${offset}-exit`, [...steps, ...advance(lastPage + 1)]);
    assertText(after, '地獄王發動攻擊');
  }
  const house = [...opening, ...Array.from({ length: 240 }, () => ['2:1', '90:0']).flat(), '240:0', '2:2', '240:0'];
  assertText(capture('original-inspection', [...house, '2:64', '30:0', '2:1', '240:0']), '什麼也沒找到');
  const village = [...house, '100:128', '240:0', '140:128', '240:0', '24:16', '180:128', '240:0',
    '48:128', '24:16', '240:0', '2:1', '60:0', '45:64', '30:0', '2:1', '240:0',
    '2:1', '240:0', '2:1', '60:0', '16:16', '48:64', '208:16', '240:0',
    '32:128', '208:16', '240:0'];
  const naturalStatus = [...village, '2:1', '240:0'];
  const naturalStatusView = capture('original-natural-status', naturalStatus);
  assertText(naturalStatusView, '看看');
  assertText(naturalStatusView, '狀態');
  assertText(capture('original-natural-status-next', [...naturalStatus, '2:1', '240:0']), '都能在這裡欣賞喔');
  const advance = count => Array.from({ length: count }, () => ['2:1', '240:0']).flat();
  const peachPages = ['桃子圖案', '目前的成長程度', '在遊戲的世界裡', '也還只是顆桃子', '精通遊戲之道吧'];
  for (const [index, text] of peachPages.entries()) {
    assertText(capture(`original-natural-peach-${index + 1}`, [...naturalStatus, ...advance(index + 2)]), text);
  }
  capture('original-natural-peach-exit', [...naturalStatus, ...advance(7)]);
  assert.equal(readFileSync(capturePath('original-natural-peach-exit.iwram')).readUInt16LE(0x2d8 + 40) & 8, 0);
  for (const [score, highlight, description, last] of [
    [20, '嬰兒圖案', '也和嬰兒沒兩樣', '精通遊戲之道吧'],
    [50, '孩童圖案', '也還只是個孩子', '精通遊戲之道吧'],
    [100, '圖案', '也能獨當一面了', '鑽研遊戲之道啊'],
  ]) {
    const setup = Array.from({ length: score / 10 }, (_, index) => `poke16:${(0x020112e0 + index * 8).toString(16)}:0:a`);
    const steps = [...village, ...setup, '2:1', '240:0', ...advance(2)];
    const name = `original-controlled-growth-${score}`;
    const view = capture(name, steps);
    const position = assertText(view, highlight);
    assert.equal(view.readUInt16LE(0xf800 + (position.row * 32 + position.column) * 2) >> 12, 14);
    const reset = assertText(view, '啊');
    assert.equal(view.readUInt16LE(0xf800 + (reset.row * 32 + reset.column) * 2) >> 12, 15);
    const state = readFileSync(capturePath(`${name}.ewram`));
    const scores = Array.from({ length: 37 }, (_, index) => state.readUInt16LE(0x112e0 + index * 8));
    assert.equal(scores.reduce((total, value) => total + value, 0), score);
    assertText(capture(`${name}-description`, [...steps, ...advance(3)]), description);
    assertText(capture(`${name}-last`, [...steps, ...advance(4)]), last);
    capture(`${name}-exit`, [...steps, ...advance(5)]);
    assert.equal(readFileSync(capturePath(`${name}-exit.iwram`)).readUInt16LE(0x2d8 + 40) & 8, 0);
  }
  assert.deepEqual(readFileSync(`${prefix}.gba`), rom);
});