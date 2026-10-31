import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { applyPrototypeIps, makeIps } from './build-prototype.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
const source = readFileSync('build/momotarou-zh-Hant.gba');
assert.equal(hash(source), '964a8fd57faf7911275dd3243e4d3938630a4498d74d2ab74a0bdf4912a35d2c');
const saves = readdirSync('build').filter(name => /\.(sav|srm)$/u.test(name))
  .map(name => [join('build', name), hash(readFileSync(join('build', name)))]);
const pagesDirectory = process.argv[2];
assert.ok(pagesDirectory, 'Usage: node tools/build-tenpx-rom.mjs build/tenpx-PREVIEW_DIRECTORY');
const pages = readFileSync(join(pagesDirectory, 'pages.bin'));
const previewReport = JSON.parse(readFileSync(join(pagesDirectory, 'report.json')));
assert.equal(pages.length, 7 * 4608);
assert.equal(previewReport.romSha256, hash(source));
assert.equal(previewReport.cellSize, 10);
assert.ok([...pages].every(value => [0x11, 0x12, 0x21, 0x22].includes(value)));
const directory = mkdtempSync('build/tenpx-rom-');
const toolchain = '/opt/devkitpro/devkitARM/bin/arm-none-eabi-';
const runtimeOffset = 0x700000;
const trampolineOffset = 0x3fffc0;
const hookOffset = 0x44222;
const snapshot = readFileSync(`${pagesDirectory}-live-before.vram`);
assert.equal(snapshot.length, 0x18000);
writeFileSync(join(directory, 'backup.bin'), Buffer.concat([snapshot.subarray(0x9000, 0xa200), snapshot.subarray(0xa800, 0xb000)]));
writeFileSync(join(directory, 'pages.s'), `.section .rodata.pages,"a",%progbits\n.balign 4\n.global preview_pages\npreview_pages:\n.incbin "${resolve(pagesDirectory, 'pages.bin')}"\n.global preview_backup\npreview_backup:\n.incbin "${resolve(directory, 'backup.bin')}"\n`);
writeFileSync(join(directory, 'runtime.ld'), `ENTRY(preview_entry)\nSECTIONS { . = 0x08700000; .text : { *(.text.entry) *(.text*) *(.rodata*) } /DISCARD/ : { *(.comment) *(.ARM.attributes) } }\n`);
execFileSync(`${toolchain}gcc`, ['-mcpu=arm7tdmi', '-mthumb', '-Os', '-ffreestanding', '-fno-builtin',
  '-Wall', '-Wextra', '-Werror', '-fstack-usage', '-c', 'tools/tenpx-rom.c', '-o', join(directory, 'runtime.o')]);
for (const [input, output] of [['tools/tenpx-rom.s', 'hook.o'], [join(directory, 'pages.s'), 'pages.o']]) {
  execFileSync(`${toolchain}as`, ['-mcpu=arm7tdmi', '-mthumb', input, '-o', join(directory, output)]);
}
execFileSync(`${toolchain}ld`, ['-T', join(directory, 'runtime.ld'), '-o', join(directory, 'runtime.elf'),
  ...['hook.o', 'runtime.o', 'pages.o'].map(path => join(directory, path))]);
execFileSync(`${toolchain}objcopy`, ['-O', 'binary', join(directory, 'runtime.elf'), join(directory, 'runtime.bin')]);
const runtime = readFileSync(join(directory, 'runtime.bin'));
assert.ok(runtime.length < 0x10000);
assert.ok(source.subarray(runtimeOffset, runtimeOffset + runtime.length).every(byte => byte === 0xff));
assert.ok(source.subarray(trampolineOffset, trampolineOffset + 8).every(byte => byte === 0xff));
assert.equal(source.subarray(hookOffset, hookOffset + 4).toString('hex'), 'fff7f7fe');
const output = Buffer.from(source);
runtime.copy(output, runtimeOffset);
output.writeUInt16LE(0x4b00, trampolineOffset);
output.writeUInt16LE(0x4718, trampolineOffset + 2);
output.writeUInt32LE(0x08000000 + runtimeOffset + 1, trampolineOffset + 4);
const displacement = trampolineOffset - (hookOffset + 4);
assert.ok(displacement >= -0x400000 && displacement < 0x400000 && displacement % 2 === 0);
output.writeUInt16LE(0xf000 | ((displacement >> 12) & 0x7ff), hookOffset);
output.writeUInt16LE(0xf800 | ((displacement >> 1) & 0x7ff), hookOffset + 2);
for (let offset = 0; offset < source.length; offset++) {
  if (source[offset] === output[offset]) continue;
  assert.ok((offset >= hookOffset && offset < hookOffset + 4) ||
    (offset >= trampolineOffset && offset < trampolineOffset + 8) ||
    (offset >= runtimeOffset && offset < runtimeOffset + runtime.length));
}
const candidate = join(directory, 'candidate.gba');
writeFileSync(candidate, output);
const manifest = {
  candidate, sha256: hash(output), baseSha256: hash(source), pagesSha256: hash(pages),
  runtimeOffset, runtimeBytes: runtime.length, hookOffset, trampolineOffset,
  scope: 'L+R house-only modal 10px comparison; A next, B exit; normal game remains 8px',
};
writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I/opt/homebrew/opt/mgba/include',
  'tools/tenpx-rom.test.c', '-L/opt/homebrew/opt/mgba/lib', '-lmgba', '-o', join(directory, 'test')]);
const testResult = execFileSync(join(directory, 'test'), [candidate, join(pagesDirectory, 'pages.bin'), `${directory}-check`], { encoding: 'utf8' });
const original = readFileSync('build/0023 - Momotarou Matsuri (J)(Rapid Fire).gba');
assert.equal(hash(original), '938fa27a934ac3f4fa93d4d9e49bd538c2fb41040d0f7a8b2de6343a406f82d3');
const patch = makeIps(original, output);
assert.deepEqual(applyPrototypeIps(original, patch), output);
assert.equal(hash(readFileSync('build/momotarou-zh-Hant.gba')), hash(source));
for (const [path, expected] of saves) assert.equal(hash(readFileSync(path)), expected);
const prefix = 'build/momotarou-zh-Hant-10px-preview';
const fontDirectory = 'assets/fonts/fusion-pixel-10px-2026.09.25';
const notices = ['OFL.txt', 'LICENSES/ark-pixel/OFL.txt', 'LICENSES/boutique-bitmap-9x9/OFL.txt', 'LICENSES/galmuri/LICENSE.txt'];
const licenses = readFileSync('build/momotarou-zh-Hant-font-licenses.txt', 'utf8') +
  '\n\nFusion Pixel 10px 2026.09.25, experimental comparison pages\n' +
  notices.map(path => `\n${path}\n${readFileSync(join(fontDirectory, path), 'utf8')}`).join('\n');
writeFileSync(`${prefix}.gba`, output);
writeFileSync(`${prefix}.ips`, patch);
writeFileSync(`${prefix}-font-licenses.txt`, licenses);
writeFileSync(`${prefix}.json`, JSON.stringify({ ...manifest, rom: `${prefix}.gba`,
  ipsSourceSha256: hash(original), ipsRoundtrip: true, savesUnchanged: true,
  validation: testResult.trim(), screenshots: {
    firstPage: `${directory}-check-page-1.png`, restored: `${directory}-check-restored.png`,
    continued: `${directory}-check-continued.png`,
  }, limitations: ['Only the exact-match verified grandparents house allocation enables the modal.',
    'Seven precomposed pages; not a general 10px text renderer or typewriter replacement.',
    'Game and interrupt-driven updates pause during the modal; real hardware remains untested.',
    'Known minigame score corruption from the 8px base is not fixed.',
    'Production basename and device ROM/saves are unchanged.'],
}, null, 2));
console.log(`${testResult.trim()}\nROM: ${prefix}.gba\nSHA256: ${hash(output)}\nIPS roundtrip: PASS`);