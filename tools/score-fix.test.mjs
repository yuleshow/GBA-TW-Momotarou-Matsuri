import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { inspectTextPointerResources } from './audit-text-pointers.mjs';

const prefix = process.argv[2];
assert.ok(prefix?.startsWith('build/score-fix-'));
const manifest = JSON.parse(readFileSync(`${prefix}.json`));
const rom = readFileSync(`${prefix}.gba`);
assert.equal(createHash('sha256').update(rom).digest('hex'), manifest.outputSha256);
const source = readFileSync('build/0023 - Momotarou Matsuri (J)(Rapid Fire).gba');
const resources = inspectTextPointerResources(source);
const numeric = resources.decodeResource(source, 0x227eb8).data;
assert.equal(numeric.length, 4096);
const directory = prefix.slice(0, prefix.lastIndexOf('/'));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('SMALLGAME_')));
function run(command, args, env = baseEnv, allowedStatus = [0]) {
  const result = spawnSync(command, args, {env, encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024});
  assert.ok(allowedStatus.includes(result.status), `${command}: ${result.error ?? result.stderr}\n${result.stdout?.slice(-2000)}`);
  return result.stdout;
}
run('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-DUSE_DEBUGGERS', '-I/opt/homebrew/opt/mgba/include',
  'build/smallgame-trace.c', '-L/opt/homebrew/opt/mgba/lib', '-lmgba', '-o', 'build/smallgame-trace']);
const results = [];
if (process.argv.includes('--arithmetic')) {
  const steps = ['360:0', '2:1', '180:0', '2:1', '90:0'];
  const glyphs = new Set(Array.from({length: manifest.dynamicGlyphCount}, (_, index) =>
    rom.subarray(manifest.tilesOffset + index * 32, manifest.tilesOffset + (index + 1) * 32).toString('hex')));
  const captureArithmetic = (name, terrain, inputs, original = false) => {
    const capture = `${directory}/arithmetic-${name}.png`;
    const env = {...baseEnv, SMALLGAME_ARITHMETIC: '1', SMALLGAME_VILLAGE: '1', SMALLGAME_RECORD: '1',
      SMALLGAME_TERRAIN: String(terrain)};
    if (!original) Object.assign(env, {
      SMALLGAME_SCORE_DONE: manifest.scoreFix.frameDoneAddress.toString(16),
      SMALLGAME_SCORE_BEGIN: manifest.scoreFix.frameBeginAddress.toString(16)});
    const log = run('build/smallgame-trace', [original ? 'build/0023 - Momotarou Matsuri (J)(Rapid Fire).gba' : `${prefix}.gba`,
      'timing', capture, ...inputs], env, [0, 5]);
    writeFileSync(`${capture}.log`, log);
    assert.match(log, /crashed=0/);
    assert.match(log, /rom_control_reads=2/);
    const memory = readFileSync(`${capture}.vram`);
    assert.deepEqual(memory.subarray(0xe000, 0xf000), numeric, `${name}: all128 native tiles`);
    if (!original) {
      assert.ok(Number(log.match(/score-sync count=(\d+)/)?.[1]) > 100, `${name}: map commits`);
      assert.ok(Number(log.match(/score-pixels count=(\d+)/)?.[1]) > 1000, `${name}: actual PPU pixels`);
      const committed = readFileSync(`${capture}.syncedmap`);
      const used = new Set();
      for (let index = 0; index < 1024; index++) {
        const entry = committed.readUInt16LE(index * 2);
        const tile = entry & 1023;
        const mapped = tile >= 0x200 && tile < 0x240 ? tile - 0x100 : tile ^ 0x200;
        assert.equal(memory.readUInt16LE(0xa800 + index * 2), (entry & 0xfc00) | mapped);
        if (index < 20 * 32 && index % 32 < 30 && tile >= 0x200 && tile < 0x240) used.add(tile - 0x200);
      }
      assert.ok(used.size > 0, `${name}: visible Chinese`);
      for (const slot of used) assert.ok(glyphs.has(memory.subarray(0xa000 + slot * 32, 0xa020 + slot * 32).toString('hex')));
    }
    results.push({name, terrain, capture, nativeTiles: 128});
    return {memory, log};
  };
  for (const terrain of [1, 2, 3, 6]) {
    const reference = captureArithmetic(`original-${terrain}`, terrain, [...steps, '120:0'], true);
    const {memory, log} = captureArithmetic(`fixed-${terrain}`, terrain, [...steps, '120:0']);
    const samples = [...log.matchAll(/arithmetic-sample .*frame=(\d+) keys=\d+ seconds=(\d+) ticks=(\d+) expired=(\d+)/g)];
    const [before, after] = samples.slice(-2).map(match => ({frame: Number(match[1]), remaining: Number(match[2]) * 60 - Number(match[3]), expired: Number(match[4])}));
    assert.equal(after.frame - before.frame, 120);
    assert.equal(before.remaining - after.remaining, 120, `terrain ${terrain}: countdown cadence`);
    assert.equal(after.expired, 0);
    const referenceSamples = [...reference.log.matchAll(/arithmetic-sample .*frame=(\d+) keys=\d+ seconds=(\d+) ticks=(\d+) expired=(\d+)/g)];
    assert.equal(Number(referenceSamples.at(-2)[2]) * 60 - Number(referenceSamples.at(-2)[3]) -
      (Number(referenceSamples.at(-1)[2]) * 60 - Number(referenceSamples.at(-1)[3])), 120);
    const tileAt = (column, row) => memory.readUInt16LE(0xf800 + (row * 32 + column) * 2) & 1023;
    let expression = '';
    for (let column = 6; column < 29; column++) {
      const tile = tileAt(column, 1);
      if (tile >= 0x100 && tile <= 0x109) expression += tile - 0x100;
      else if (tile === 0x114) expression += '+';
      else if (tile === 0x115) expression += '-';
      else if (tile === 0x140) expression += '*';
      else if (tile === 0x155) expression += '/';
      else if (tile === 0x153) break;
      else assert.equal(tile, 0x20, `Unexpected arithmetic token ${tile.toString(16)}`);
    }
    assert.match(expression, /^\d+(?:[+*/-]\d+)+$/);
    let answer;
    if (/[*/]/.test(expression)) {
      assert.match(expression, /^\d+[*/]\d+$/);
      const [left, right] = expression.split(/[*/]/).map(Number);
      answer = expression.includes('*') ? left * right : left / right;
    } else answer = expression.match(/[+-]?\d+/g).reduce((total, term) => total + Number(term), 0);
    const choices = [16, 17, 18].map(row => Number([26, 27, 28].map(column => String.fromCharCode(tileAt(column, row))).join('').trim()));
    const selected = choices.indexOf(answer);
    assert.ok(selected >= 0, `${expression}=${answer}, choices ${choices}`);
    const select = index => [...Array.from({length: index}, () => ['2:128', '2:0']).flat(), '2:1', '240:0'];
    const advances = Array.from({length: 12}, () => ['2:1', '90:0']).flat();
    const correct = captureArithmetic(`correct-${terrain}`, terrain, [...steps, '120:0', ...select(selected), ...advances]);
    assert.match(correct.log, /arithmetic-result phase=answer result=1/);
    assert.match(correct.log, /arithmetic-result phase=return result=2/);
    if (terrain === 1) {
      const wrong = captureArithmetic('wrong', terrain, [...steps, '120:0', ...select((selected + 1) % 3), ...advances]);
      assert.match(wrong.log, /arithmetic-result phase=answer result=0/);
      assert.match(wrong.log, /arithmetic-result phase=return result=2/);
      const expired = captureArithmetic('timeout', terrain, [...steps, '900:0', ...advances]);
      assert.match(expired.log, /arithmetic-result phase=answer result=0/);
      assert.match(expired.log, /expired=1/);
      assert.match(expired.log, /arithmetic-result phase=return result=2/);
    }
    console.log(`PASS arithmetic terrain ${terrain}: 128 native tiles, Chinese glyphs, PPU pixels, 120/120 countdown, input-driven correct answer`);
  }
  writeFileSync(`${directory}/arithmetic-validation.json`, `${JSON.stringify({romSha256: manifest.outputSha256, results,
    scope: 'Controlled map encounter; no ROM, answer, RNG or save writes. Real buttons answer displayed equations. Not a natural encounter or handheld test.'}, null, 2)}\n`);
  process.exit(0);
}
for (const [kind, path, delay] of [['original', 'build/0023 - Momotarou Matsuri (J)(Rapid Fire).gba', 120],
  ['fixed', `${prefix}.gba`, 120], ['fixed-alt', `${prefix}.gba`, 121]]) {
  const capture = `${directory}/even-${kind}.png`;
  const env = {...baseEnv, SMALLGAME_EVEN: '1', SMALLGAME_TRANSITION: '1', SMALLGAME_VILLAGE: '1', SMALLGAME_RECORD: '1'};
  if (kind !== 'original') Object.assign(env, {SMALLGAME_SCORE_FIX: '1',
    SMALLGAME_GLYPH_LIBRARY: (0x08000000 + manifest.tilesOffset).toString(16),
    SMALLGAME_SCORE_DONE: manifest.scoreFix.frameDoneAddress.toString(16),
    SMALLGAME_SCORE_BEGIN: manifest.scoreFix.frameBeginAddress.toString(16)});
  const log = run('build/smallgame-trace', [path, 'timing', capture, '360:0',
    ...Array.from({length: 90}, () => ['2:1', `${delay}:0`]).flat()], env);
  writeFileSync(`${capture}.log`, log);
  assert.match(log, /summary .*returned=1 crashed=0 .*completed_runs=1/);
  assert.match(log, /control_reads=1/);
  assert.match(log, /rom_control_reads=2/);
  const pages = [...log.matchAll(/screenshot frame=\d+ path=(.+success-page-\d+\.png)/g)].map(match => match[1]);
  assert.ok(pages.length >= 8);
  const observedNumbers = [];
  for (const page of pages) {
    const memory = readFileSync(`${page}.vram`);
    assert.deepEqual(memory.subarray(0xe000, 0xf000), numeric, `${page}: all128 native tiles`);
    if (kind !== 'original') {
      const committed = readFileSync(`${page}.syncedmap`);
      for (let index = 0; index < 1024; index++) {
        const entry = committed.readUInt16LE(index * 2);
        const tile = entry & 1023;
        const mapped = tile >= 0x200 && tile < 0x240 ? tile - 0x180 : (tile + 0x200) & 1023;
        assert.equal(memory.readUInt16LE(0xa000 + index * 2), (entry & 0xfc00) | mapped);
      }
    }
    for (let row = 5; row < 13; row++) {
      let digits = '';
      for (let column = 10; column < 20; column++) {
        const tile = memory.readUInt16LE(0xf800 + (row * 32 + column) * 2) & 1023;
        if (tile >= 0x100 && tile < 0x10a) digits += tile - 0x100;
      }
      if (digits) observedNumbers.push({page, digits});
    }
  }
  if (kind !== 'original') {
    const glyphs = log.split('\n').filter(line => line.startsWith('success-glyph '));
    assert.ok(glyphs.length > 50 && glyphs.every(line => line.endsWith('matches=1')));
    assert.equal([...log.matchAll(/score-pixels count=(\d+)/g)].filter(match => Number(match[1]) >= 14080).length, pages.length);
  }
  results.push({kind, pages: pages.length, observedNumbers, log: `${capture}.log`});
  console.log(`PASS even-${kind}: ${pages.length} pages, all128 native tiles, returned to house`);
}
writeFileSync(`${directory}/even-validation.json`, `${JSON.stringify({romSha256: manifest.outputSha256, results,
  scope: 'Controlled native wrapper, real buttons determine dice. No score, RNG or save writes. PPU pixels include central number.'}, null, 2)}\n`);