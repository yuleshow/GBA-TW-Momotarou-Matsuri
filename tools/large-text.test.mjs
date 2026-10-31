import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { applyPrototypeIps, translationFont } from './build-prototype.mjs';
import { encodeBattleResult, encodeLargeDialogue, encodeLargeLabel, thumbCall } from './build-dialogue.mjs';
import { readRom } from './inspect-rom.mjs';

test('native Silver UI renders aligned menus, cursors, help and paged dialogue', {
  skip: translationFont.name !== 'Silver' && 'Retired Silver build; run original-layout.test.mjs for the active font',
}, () => {
  const prefix = 'build/momotarou-zh-Hant-silver-large-experimental';
  const smallPrefix = 'build/momotarou-zh-Hant-dialogue-experimental';
  const source = readRom();
  const rom = readFileSync(`${prefix}.gba`);
  const smallRom = readFileSync(`${smallPrefix}.gba`);
  const manifest = JSON.parse(readFileSync(`${prefix}.json`));
  const base = JSON.parse(readFileSync('build/momotarou-zh-Hant-menu-prototype.json'));
  const large = manifest.largeText;
  const glyphTiles = new Map(Object.entries(large.glyphTiles));
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  assert.equal(hash(rom), manifest.outputSha256);
  assert.deepEqual(applyPrototypeIps(source, readFileSync(`${prefix}.ips`)), rom);
  assert.equal(large.maxLinesPerPage, 1);
  assert.equal(manifest.cacheSlots, 128);
  assert.equal(manifest.baseTranslationCount, 0);
  assert.equal(rom.readUInt32LE(0x46a7c), source.readUInt32LE(0x46a7c));
  const allowed = Buffer.alloc(source.length);
  allowed.fill(1, 0x46a7c, 0x46a80);
  for (const allocation of [...base.allocations, ...manifest.allocations]) {
    allowed.fill(1, allocation.offset, allocation.offset + allocation.size);
  }
  for (const hook of manifest.hooks) {
    allowed.fill(1, hook.offset, hook.offset + 4);
    assert.deepEqual(rom.subarray(hook.offset, hook.offset + 4), thumbCall(hook.offset, hook.target));
  }
  for (const patch of manifest.layoutPatches) {
    const before = Buffer.from(patch.sourceHex, 'hex');
    const after = Buffer.from(patch.targetHex, 'hex');
    assert.equal(before.length, after.length);
    assert.deepEqual(source.subarray(patch.offset, patch.offset + before.length), before);
    assert.deepEqual(rom.subarray(patch.offset, patch.offset + after.length), after);
    allowed.fill(1, patch.offset, patch.offset + after.length);
  }
  for (const entry of base.translated.filter(entry => !manifest.translated.some(native => native.offset === entry.offset))) {
    for (const pointer of entry.pointerOffsets) assert.equal(rom.readUInt32LE(pointer), source.readUInt32LE(pointer));
  }
  for (const entry of [...base.translated, ...manifest.translated]) {
    for (const pointer of entry.pointerOffsets) allowed.fill(1, pointer, pointer + 4);
  }
  for (const entry of manifest.translated) {
    assert.ok(['16x16-label', '16x16-quadrants', 'ascii-format', 'battle-result'].includes(entry.layout));
    const encoded = entry.layout === 'ascii-format' ? Buffer.from(entry.translation + '\0', 'ascii')
      : entry.layout === 'battle-result' ? encodeBattleResult(entry.result, glyphTiles)
      : entry.layout === '16x16-label' ? encodeLargeLabel(large.labels[entry.offset], glyphTiles)
      : encodeLargeDialogue(entry.pages, glyphTiles);
    if (['ascii-format', 'battle-result'].includes(entry.layout)) {
      assert.deepEqual(entry.translation.match(/%\d*[sd]/g), Buffer.from(entry.sourceHex, 'hex').toString('ascii').match(/%\d*[sd]/g));
    }
    assert.deepEqual(rom.subarray(entry.targetOffset, entry.targetOffset + encoded.length), encoded);
    for (const pointer of entry.pointerOffsets) assert.equal(rom.readUInt32LE(pointer), entry.targetOffset + 0x08000000);
    const offset = Number.parseInt(entry.offset, 16);
    assert.deepEqual(rom.subarray(offset, offset + entry.sourceHex.length / 2 + 1),
      source.subarray(offset, offset + entry.sourceHex.length / 2 + 1));
  }
  for (let offset = 0; offset < source.length; offset++) {
    if (source[offset] !== rom[offset]) assert.equal(allowed[offset], 1, `Unexpected change: ${offset.toString(16)}`);
  }
  const rasterized = readFileSync('build/large-tiles.bin');
  const fullGlyphs = new Set();
  for (const [index, character] of large.characters.entries()) {
    const glyph = rasterized.subarray(index * 128, (index + 1) * 128);
    assert.equal(glyph.length, 128);
    assert.ok(glyph.some(byte => byte !== 0x11), `Blank native glyph: ${character}`);
    assert.ok([...glyph].every(byte => [0x11, 0x12, 0x21, 0x22].includes(byte)));
    assert.ok(!fullGlyphs.has(glyph.toString('hex')), `Duplicate native glyph: ${character}`);
    fullGlyphs.add(glyph.toString('hex'));
    for (const [quadrant, tileId] of glyphTiles.get(character).entries()) {
      assert.deepEqual(rom.subarray(manifest.tilesOffset + tileId * 32, manifest.tilesOffset + (tileId + 1) * 32),
        glyph.subarray(quadrant * 32, (quadrant + 1) * 32));
    }
  }
  const capture = (name, steps, path = `${prefix}.gba`) => {
    console.log(`Checking ${name}`);
    execFileSync('build/capture', [path, `build/${name}`, ...steps], { stdio: 'ignore' });
    return readFileSync(`build/${name}.vram`);
  };
  const assertLine = (vram, text, dialogue = true, expected) => {
    const matches = [];
    for (let row = 0; row < 19; row++) {
      for (let column = 0; column + [...text].length * 2 <= 30; column++) {
        const aligned = [...text].every((character, index) => glyphTiles.get(character).every((tileId, quadrant) => {
          const mapOffset = 0xf800 + ((row + (quadrant >> 1)) * 32 + column + index * 2 + (quadrant & 1)) * 2;
          const slot = vram.readUInt16LE(mapOffset) & 0x3ff;
          if (slot < 0x100 || slot >= 0x100 + manifest.cacheSlots) return false;
          return vram.subarray(0xc000 + slot * 32, 0xc000 + (slot + 1) * 32)
            .equals(rom.subarray(manifest.tilesOffset + tileId * 32, manifest.tilesOffset + (tileId + 1) * 32));
        }));
        if (aligned && (!expected || (row === expected.row && column === expected.column))) matches.push({ row, column });
      }
    }
    assert.equal(matches.length, 1, `Expected one visible aligned native line: ${text}`);
    const location = matches[0];
    if (!dialogue) return location;
    assert.ok(location.row >= 16 && location.row <= 17, 'Native line crossed the dialogue border');
    for (let row = 16; row <= 18; row++) {
      for (let column = 6; column <= 24; column++) {
        if (row >= location.row && row <= location.row + 1 && column >= location.column &&
            column < location.column + [...text].length * 2) continue;
        const tile = vram.readUInt16LE(0xf800 + (row * 32 + column) * 2) & 0x3ff;
        assert.ok(tile < 0x100 || tile >= 0x100 + manifest.cacheSlots, `Stale glyph outside current line at ${column},${row}`);
      }
    }
    return location;
  };
  const start = ['900:0', '2:8', '180:0', '2:8', '180:0'];
  const opening = [...start, '2:1', '1500:0'];
  const techniques = [...opening, '2:128', '15:0', '2:1', '90:0'];
  const items = [...opening, '2:128', '15:0', '2:128', '15:0', '2:1', '90:0'];
  const cursorTile = (vram, column, row) => vram.readUInt16LE(0xf800 + (row * 32 + column) * 2) & 0x3ff;
  const assertCursor = (vram, column, selected, count) => {
    for (let index = 0; index < count; index++) {
      const tile = cursorTile(vram, column, 6 + index * 2);
      if (index === selected) assert.ok(tile >= 0x22 && tile <= 0x25, 'Missing animated cursor');
      else assert.equal(tile, 0x20, 'Old cursor was not cleared');
    }
  };
  const names = ['桃太郎', '金太郎', '浦島', '夜叉姬'];
  const assertStatus = (vram, captureName) => {
    const iwram = readFileSync(`build/${captureName}.iwram`);
    for (const [index, name] of names.entries()) {
      assertLine(vram, name, false, { row: 1, column: 2 + index * 7 });
      for (const [row, label, valueOffset] of [[3, 'HP', 4], [4, 'MP', 6]]) {
        const value = iwram.readUInt16LE(0x228 + index * 8 + valueOffset);
        const text = label + String(value).padStart(3, ' ');
        for (const [characterIndex, character] of [...text].entries()) {
          assert.equal(cursorTile(vram, 2 + index * 7 + characterIndex, row), character.charCodeAt(0),
            `Status value mismatch: ${name} ${text}`);
        }
      }
    }
  };
  assert.deepEqual(assertLine(capture('large-start', start), '開始遊戲', false), { row: 13, column: 7 });
  assert.equal(rom.readUInt32LE(0x45244), 0x1c0d2101);
  const threeOptions = ['patch32:8045244:1c0d2101:1c0d2103', ...start];
  const allOptions = capture('large-start-three-options', threeOptions);
  for (const [index, text] of ['開始遊戲', '繼續遊戲', '刪除存檔'].entries()) {
    assert.deepEqual(assertLine(allOptions, text, false), { row: 13 + index * 2, column: 7 });
  }
  const lastOption = capture('large-start-last-option', [...threeOptions, '2:128', '30:0', '2:128', '30:0']);
  const selectedTile = cursorTile(lastOption, 6, 17);
  assert.ok(selectedTile >= 0x22 && selectedTile <= 0x25);
  assert.equal(cursorTile(lastOption, 6, 13), 0x20);
  assert.equal(cursorTile(lastOption, 6, 15), 0x20);
  const commands = ['戰鬥', '術法', '道具', '防禦'];
  const commandView = capture('large-battle', opening);
  for (const [index, text] of commands.entries()) {
    assert.deepEqual(assertLine(commandView, text, false), { row: 6 + index * 2, column: 3 });
  }
  assertStatus(commandView, 'large-battle');
  assertCursor(commandView, 2, 0, 4);
  const techniqueView = capture('large-techniques', techniques);
  for (const [index, text] of ['仙金丹', '鹿角', '閃電'].entries()) {
    assert.deepEqual(assertLine(techniqueView, text, false), { row: 6 + index * 2, column: 9 });
  }
  assertLine(techniqueView, '恢復一人體力');
  const itemView = capture('large-items', items);
  for (const [index, text] of ['仙金丹糖', '恆河沙珠', '閃電珠'].entries()) {
    assert.deepEqual(assertLine(itemView, text, false), { row: 6 + index * 2, column: 9 });
  }
  assertStatus(itemView, 'large-items');
  assertLine(itemView, '恢復一人體力');
  const targetView = capture('large-status-target', [...techniques, '2:1', '90:0']);
  assertStatus(targetView, 'large-status-target');
  for (const [index, name] of names.entries()) assertLine(targetView, name, false, { row: 6 + index * 2, column: 17 });
  assertCursor(targetView, 16, 0, 4);
  assertLine(targetView, '恢復一人體力');
  const itemCancel = capture('large-item-target-cancel', [...items, '2:1', '60:0', '2:2', '60:0', '2:128', '60:0']);
  assertLine(itemCancel, '恢復一人體力術力');
  assertCursor(itemCancel, 8, 1, 3);
  const commandReturn = capture('large-battle-return', [...items, '2:2', '60:0', '2:128', '60:0']);
  assertCursor(commandReturn, 2, 3, 4);
  for (const text of commands) assertLine(commandReturn, text, false);
  const tauntSteps = [...opening, '2:1', '120:0'];
  const taunt = capture('large-hope-taunt', tauntSteps);
  assertLine(taunt, '什麼希望！');
  assertStatus(taunt, 'large-hope-taunt');
  for (const offset of ['167fdd', '167fee', '167fff']) {
    const entry = manifest.translated.find(record => record.offset === offset);
    const redirect = `patch32:804227c:${rom.readUInt32LE(0x4227c).toString(16)}:${(0x08000000 + entry.targetOffset).toString(16)}`;
    const name = `large-taunt-${offset}`;
    const view = capture(name, [...opening, redirect, '2:1', '120:0']);
    assertLine(view, entry.pages[0][0]);
    assertStatus(view, name);
  }
  const naturalBattle = capture('large-natural-battle-dialogue', [...opening, '2:1', '120:0', '2:1', '240:0']);
  assertLine(naturalBattle, '地獄王發動攻擊！');
  assertStatus(naturalBattle, 'large-natural-battle-dialogue');
  const advance = count => Array.from({ length: count }, () => ['2:1', '240:0']).flat();
  const health = name => readFileSync(`build/${name}.iwram`).readUInt16LE(0x22c);
  const assertResult = (view, message, value) => {
    const location = assertLine(view, message);
    assert.equal(location.row, 16);
    const digits = String(value);
    for (const [index, digit] of [...digits].entries()) {
      assert.equal(cursorTile(view, location.column + index, 18), digit.charCodeAt(0));
    }
    for (let column = location.column + digits.length; column < 24; column++) {
      assert.equal(cursorTile(view, column, 18), 0x20, 'Stale result digits');
    }
  };
  const damage = capture('large-player-damage', [...opening, ...advance(4)]);
  assertResult(damage, '受到傷害', health('large-battle') - health('large-player-damage'));
  assertStatus(damage, 'large-player-damage');
  const enemyDamage = capture('large-enemy-damage', [...opening, ...advance(7)]);
  assertLine(enemyDamage, '受到傷害');
  const spell = [...techniques, '2:1', '90:0', '2:1', '120:0'];
  capture('large-heal-before', [...spell, ...advance(3)]);
  const heal = capture('large-heal-result', [...spell, ...advance(8)]);
  assertResult(heal, '恢復體力', health('large-heal-result') - health('large-heal-before'));
  assertStatus(heal, 'large-heal-result');
  assertLine(capture('large-heal-next', [...spell, ...advance(9)]), '金太郎使出掌擊！');
  const recoveryItem = [...items, '2:128', '30:0', '2:1', '90:0', '2:1', '120:0'];
  capture('large-mp-before', [...recoveryItem, ...advance(5)]);
  const mpRecovery = capture('large-mp-result', [...recoveryItem, ...advance(9)]);
  const beforeMp = readFileSync('build/large-mp-before.iwram').readUInt16LE(0x22e);
  const afterMp = readFileSync('build/large-mp-result.iwram').readUInt16LE(0x22e);
  assert.ok(afterMp > beforeMp, 'Expected nonzero MP recovery');
  assertResult(mpRecovery, '恢復術力', afterMp - beforeMp);
  assertStatus(mpRecovery, 'large-mp-result');
  for (const offset of ['168190', '1681bd', '1681f6', '16821e', '16822f', '168260', '168286', '168359', '168374', '16838f']) {
    const entry = manifest.translated.find(record => record.offset === offset);
    const redirect = `patch32:804227c:${rom.readUInt32LE(0x4227c).toString(16)}:${(0x08000000 + entry.targetOffset).toString(16)}`;
    assertLine(capture(`large-action-${offset}`, [...opening, redirect, '2:1', '240:0', ...advance(entry.pages.length - 1)]),
      entry.pages.at(-1)[0]);
  }
  const house = [...opening, ...Array.from({ length: 240 }, () => ['2:1', '90:0']).flat(), '240:0', '2:2', '240:0'];
  const inspect = ['2:64', '30:0', '2:1', '240:0'];
  assertLine(capture('large-inspection', [...house, ...inspect]), '什麼也沒找到。');
  const inspection = manifest.translated.find(entry => entry.offset === '163b46');
  const patches = inspection.pointerOffsets.map(pointer =>
    `patch32:${(0x08000000 + pointer).toString(16)}:${rom.readUInt32LE(pointer).toString(16)}:${(0x08000000 + large.probe.targetOffset).toString(16)}`);
  const probe = [...house, ...patches, ...inspect];
  const first = capture('large-portrait-page1', probe);
  const second = capture('large-portrait-page2', [...probe, '2:1', '240:0']);
  assert.equal(assertLine(first, '什麼也沒找到。').column, assertLine(second, '再找找看吧！').column);
  const story = manifest.translated.find(entry => entry.offset === '16800f');
  const storyPatches = inspection.pointerOffsets.map(pointer =>
    `patch32:${(0x08000000 + pointer).toString(16)}:${rom.readUInt32LE(pointer).toString(16)}:${(0x08000000 + story.targetOffset).toString(16)}`);
  for (const [index, page] of story.pages.entries()) {
    assertLine(capture(`large-story-page${index + 1}`, [...house, ...storyPatches, ...inspect,
      ...Array.from({ length: index }, () => ['2:1', '240:0']).flat()]), page[0]);
  }
  const exit = capture('large-exit', [...probe, '2:1', '240:0', '2:1', '120:0', '100:128', '240:0']);
  const naturalExit = capture('large-inspection-exit', [...house, ...inspect, '2:1', '120:0', '100:128', '240:0']);
  assert.deepEqual(exit.subarray(0xf800, 0x10000), naturalExit.subarray(0xf800, 0x10000),
    'Probe did not return to the normal exterior text map');
  assert.deepEqual(readFileSync(`${prefix}.gba`), rom);
  assert.deepEqual(readFileSync(`${smallPrefix}.gba`), smallRom);
});