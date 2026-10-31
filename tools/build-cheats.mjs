import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const rom = readFileSync('build/momotarou-zh-Hant.gba');
const sha256 = createHash('sha256').update(rom).digest('hex');
assert.equal(sha256, '1de651d86629da993d1a0760de36c62bb75a4634ae024a7c062a42e21f0f39b5');
const cheats = [
  {description: 'Battle HP refill on status update (all allies)', address: 0x08041df2, before: 0xd900, value: 0x46c0},
  {description: 'Battle MP refill on status update (all allies)', address: 0x08041dfc, before: 0xd900, value: 0x46c0},
  {description: 'Paper fan ONLY - freeze reaction timer (A still works)', address: 0x0801aff8, before: 0x3001, value: 0x46c0},
  {description: 'Money 999999 (disable after use; changed balance remains)', address: 0x020005b0, value: 999999, width: 8},
  {description: 'Mountain race ONLY - freeze elapsed time (reach the finish yourself)', address: 0x08016568, before: 0x3001, value: 0x46c0},
  {description: 'No random field encounters (walking only; NPC and item events retained)', address: 0x0800117a, before: 0xd026, value: 0xe026, code: '600008BD 0000E026'},
];
const lines = [`cheats = ${cheats.length}`, ''];
for (const [index, cheat] of cheats.entries()) {
  if (cheat.before !== undefined) assert.equal(rom.readUInt16LE(cheat.address - 0x08000000), cheat.before);
  cheat.code ??= `${cheat.address.toString(16).toUpperCase().padStart(8, '0')}:${cheat.value.toString(16).toUpperCase().padStart(cheat.width ?? 4, '0')}`;
  lines.push(`cheat${index}_desc = "${cheat.description}"`, `cheat${index}_code = "${cheat.code}"`,
    `cheat${index}_enable = false`, `cheat${index}_handler = 0`, '');
}
writeFileSync('build/momotarou-zh-Hant.cht', lines.join('\n'));
writeFileSync('build/momotarou-zh-Hant-cheats.json', JSON.stringify({sha256, cheats,
  status: 'candidate-not-deployed', limitations: ['Refills on status updates, not guaranteed immunity to lethal damage.',
    'Paper-fan timer applies only to its reaction phase, not other minigames.',
    'Money changes RAM and may be saved by the game; disabling does not restore the previous balance.',
    'Mountain-race timer freezes the current elapsed time, not movement. Enable before racing; it does not rewind time or grant the reward. Finish normally and disable afterward. A resulting record may persist in the game save.',
    'No random field encounters skips the map walking encounter block, including beneficial encounters. NPC, scripted and item-triggered entry points remain unchanged. Does not cancel an encounter already started. Close and reopen content when replacing or disabling ROM cheats in RetroArch.']}, null, 2) + '\n');
console.log('Generated disabled cheat candidate for local verification.');