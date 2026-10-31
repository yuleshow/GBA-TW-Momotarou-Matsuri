import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { thumbCall } from './build-dialogue.mjs';
import { inspectTextPointerResources } from './audit-text-pointers.mjs';
import { makeIps, applyPrototypeIps } from './build-prototype.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const basePath = 'build/momotarou-zh-Hant-10px-preview.gba';
const base = readFileSync(basePath);
assert.equal(hash(base), 'dfc17977742e5c5826e3ff29d6ac066fdfdb1513df563fa5db37fafcd914b34e');
const baselinePath = 'build/score-fix-base-manifest.json';
const manifestBytes = readFileSync(existsSync(baselinePath) ? baselinePath : 'build/momotarou-zh-Hant.json');
const manifest = JSON.parse(manifestBytes);
assert.equal(manifest.outputSha256, '964a8fd57faf7911275dd3243e4d3938630a4498d74d2ab74a0bdf4912a35d2c');
if (!existsSync(baselinePath)) writeFileSync(baselinePath, manifestBytes, {flag: 'wx'});
const preview = JSON.parse(readFileSync('build/momotarou-zh-Hant-10px-preview.json'));
assert.equal(preview.sha256, hash(base));
const original = readFileSync('build/0023 - Momotarou Matsuri (J)(Rapid Fire).gba');
assert.equal(hash(original), manifest.sourceSha256);
const resources = inspectTextPointerResources(original);
const native = resources.decodeResource(original, 0x254fa4).data;
assert.equal(native.length, 0xde0);
const marker = native.subarray(0xdc0, 0xde0);
assert.ok(marker.some(byte => byte !== 0));
for (const offset of [0x227eb8, 0x2cb834]) {
  assert.ok(!resources.decodeResource(original, offset).data.subarray(0xdc0, 0xde0).equals(marker));
}
const directory = mkdtempSync('build/score-fix-');
const start = 0x710000;
const toolchain = '/opt/devkitpro/devkitARM/bin/arm-none-eabi-';
writeFileSync(join(directory, 'marker.bin'), marker);
const commonResource = resources.decodeResource(original, 0x227eb8).data;
assert.equal(commonResource.length, 0x1000);
writeFileSync(join(directory, 'even-marker.bin'), commonResource.subarray(0xdc0, 0xde0));
writeFileSync(join(directory, 'marker.s'), `.section .rodata.marker,"a",%progbits\n.balign 4\n.global timing_marker\ntiming_marker:\n.incbin "${resolve(directory, 'marker.bin')}"\n.global even_marker\neven_marker:\n.incbin "${resolve(directory, 'even-marker.bin')}"\n`);
writeFileSync(join(directory, 'runtime.ld'), `ENTRY(menu_glyph_hook)\nSECTIONS { . = 0x08710000; .text : { *(.text.hooks) *(.text*) *(.rodata*) } /DISCARD/ : { *(.comment) *(.ARM.attributes) } }\n`);
for (const name of ['glyph-loader', 'score-font']) {
  execFileSync(`${toolchain}gcc`, ['-mcpu=arm7tdmi', '-mthumb', '-Os', '-ffreestanding', '-fno-builtin',
    '-Wall', '-Wextra', '-Werror', '-DSCORE_CACHE', '-c', `tools/${name}.c`, '-o', join(directory, `${name}.o`)]);
}
for (const [path, name] of [['tools/glyph-hooks.s', 'glyph-hooks'], ['tools/score-hooks.s', 'score-hooks'], [join(directory, 'marker.s'), 'marker']]) {
  execFileSync(`${toolchain}as`, ['-mcpu=arm7tdmi', '-mthumb', path, '-o', join(directory, `${name}.o`)]);
}
const countOffset = manifest.allocations.find(allocation => allocation.label === 'dynamic-glyph-count').offset;
execFileSync(`${toolchain}ld`, ['-T', join(directory, 'runtime.ld'),
  '--defsym', `chinese_glyphs=0x${(0x08000000 + manifest.tilesOffset).toString(16)}`,
  '--defsym', `chinese_glyph_count=0x${(0x08000000 + countOffset).toString(16)}`,
  ...['glyph-hooks', 'glyph-loader', 'score-font', 'score-hooks', 'marker'].map(name => join(directory, `${name}.o`)),
  '-o', join(directory, 'runtime.elf')]);
execFileSync(`${toolchain}objcopy`, ['-O', 'binary', join(directory, 'runtime.elf'), join(directory, 'runtime.bin')]);
const symbols = new Map(execFileSync(`${toolchain}nm`, ['--defined-only', join(directory, 'runtime.elf')], {encoding: 'utf8'})
  .trim().split('\n').map(line => { const [address, , name] = line.trim().split(/\s+/); return [name, parseInt(address, 16)]; }));
const runtime = readFileSync(join(directory, 'runtime.bin'));
assert.ok(runtime.length < 0x10000 && base.subarray(start, start + runtime.length).every(byte => byte === 255));
const output = Buffer.from(base);
runtime.copy(output, start);
const replacements = [[0x3d418, 0x3fffd0, 'menu_glyph_hook'], [0x3d2ac, 0x3fffd8, 'sjis_glyph_hook'], [0x441f6, 0x3fffe0, 'score_frame_hook']];
for (const [offset, trampoline, symbol] of replacements) {
  assert.ok(base.subarray(trampoline, trampoline + 8).every(byte => byte === 255));
  const expected = offset === 0x441f6 ? 0x442d8 : manifest.hooks.find(hook => hook.offset === offset).target;
  assert.deepEqual(base.subarray(offset, offset + 4), thumbCall(offset, expected));
  output.writeUInt16LE(0x4b00, trampoline);
  output.writeUInt16LE(0x4718, trampoline + 2);
  output.writeUInt32LE(symbols.get(symbol) | 1, trampoline + 4);
  thumbCall(offset, trampoline).copy(output, offset);
}
for (let offset = 0; offset < output.length; offset++) {
  if (output[offset] === base[offset]) continue;
  assert.ok((offset >= start && offset < start + runtime.length) || replacements.some(([hook, trampoline]) =>
    (offset >= hook && offset < hook + 4) || (offset >= trampoline && offset < trampoline + 8)));
}
const patch = makeIps(original, output);
assert.deepEqual(applyPrototypeIps(original, patch), output);
const prefix = join(directory, 'momotarou-zh-Hant');
writeFileSync(`${prefix}.gba`, output);
writeFileSync(`${prefix}.ips`, patch);
writeFileSync(`${prefix}-font-licenses.txt`, readFileSync('build/momotarou-zh-Hant-10px-preview-font-licenses.txt'));
writeFileSync(`${prefix}.json`, JSON.stringify({...manifest, outputSha256: hash(output),
  hooks: replacements.slice(0, 2).map(([offset, target, symbol]) => ({offset, target, symbol})),
  allocations: [...manifest.allocations,
    {label: 'tenpx-preview-runtime', offset: preview.runtimeOffset, size: preview.runtimeBytes},
    {label: 'tenpx-preview-trampoline', offset: preview.trampolineOffset, size: 8},
    {label: 'score-fix-runtime', offset: start, size: runtime.length},
    ...replacements.map(([, offset, symbol]) => ({label: `${symbol}-trampoline`, offset, size: 8}))],
  additionalHooks: [preview.hookOffset, 0x441f6].map(offset => ({offset,
    originalHex: original.subarray(offset, offset + 4).toString('hex'),
    installedHex: output.subarray(offset, offset + 4).toString('hex')})),
  tenpxPreview: preview,
  scoreFix: {baseSha256: hash(base), codeOffset: start, codeBytes: runtime.length, virtualTileStart: 0x200,
    frameDoneAddress: symbols.get('score_frame_done'),
    frameBeginAddress: symbols.get('score_frame_begin'),
    cacheAddress: 0x06009000, displayMapAddress: 0x0600a000, sourceMapAddress: 0x0600f800,
    markerSha256: hash(marker), evenMarkerSha256: hash(commonResource.subarray(0xdc0, 0xde0)),
    scenes: [{gameId: 0, textLayer: 0, nativeResource: 0x227eb8},
      {gameId: 11, textLayer: 2, nativeResource: 0x254fa4},
      {gameId: 15, textLayer: 2, nativeResource: 0x227eb8},
      {gameId: 28, textLayer: 0, nativeResource: 0x227eb8,
        cacheAddress: 0x0600a000, displayMapAddress: 0x0600a800, textConfig: 0x1508}],
    frameHook: 0x441f6, status: 'candidate-not-deployed'},
}, null, 2));
console.log(prefix);