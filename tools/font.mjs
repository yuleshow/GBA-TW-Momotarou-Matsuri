import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { inspectRom, readRom } from './inspect-rom.mjs';

export function decodePairs(source, offset) {
  const start = offset;
  if (source[offset] !== 0x90) throw new Error('Expected a 0x90 pair-compressed resource');
  const size = source.readUIntLE(offset + 1, 3);
  offset += 4;
  if (size > 0x1000000 || source.readUInt32BE(offset) !== size) throw new Error('Invalid resource size');
  offset += 4;
  const output = Buffer.alloc(size);
  let written = 0;
  const byte = () => {
    if (offset >= source.length) throw new Error('Truncated pair resource');
    return source[offset++];
  };
  while (written < size) {
    const pairs = new Map();
    const count = byte();
    for (let index = 0; index < count; index++) pairs.set(byte(), [byte(), byte()]);
    const tokens = (byte() << 8) | byte();
    if (!tokens) throw new Error('Empty pair block');
    for (let index = 0; index < tokens; index++) {
      const stack = [byte()];
      let steps = 0;
      while (stack.length) {
        if (++steps > size * 2 + 256) throw new Error('Cyclic or oversized pair expansion');
        const value = stack.pop();
        const pair = pairs.get(value);
        if (pair) {
          stack.push(pair[1], pair[0]);
        } else {
          if (written >= size) throw new Error('Pair output exceeds declared size');
          output[written++] = value;
        }
      }
    }
  }
  return { data: output, consumed: offset - start };
}

export function encodeLiteralPairs(data) {
  if (!data.length || data.length > 0xffffff) throw new Error('Invalid resource size');
  const header = Buffer.alloc(8);
  header[0] = 0x90;
  header.writeUIntLE(data.length, 1, 3);
  header.writeUInt32BE(data.length, 4);
  const blocks = [header];
  for (let offset = 0; offset < data.length; offset += 0x7fff) {
    const block = data.subarray(offset, offset + 0x7fff);
    const blockHeader = Buffer.alloc(3);
    blockHeader.writeUInt16BE(block.length, 1);
    blocks.push(blockHeader, block);
  }
  return Buffer.concat(blocks);
}

export function validateGlyphTiles(characters, tiles) {
  if (tiles.length !== characters.length * 32) throw new Error('Glyph tile count mismatch');
  const seen = new Map();
  for (const [index, character] of characters.entries()) {
    const tile = tiles.subarray(index * 32, (index + 1) * 32);
    if (tile.some(byte => ![0x11, 0x12, 0x21, 0x22].includes(byte))) {
      throw new Error(`Invalid glyph palette: ${character}`);
    }
    if (tile.every(byte => byte === 0x11)) throw new Error(`Blank glyph: ${character}`);
    const key = tile.toString('hex');
    if (seen.has(key)) throw new Error(`Identical glyphs: ${seen.get(key)} and ${character}`);
    seen.set(key, character);
  }
}

export function tileSheet(data) {
  if (data.length % 32) throw new Error('Expected whole 4bpp tiles');
  const width = 16 * 10;
  const height = Math.ceil(data.length / 32 / 16) * 10;
  const pixels = Buffer.alloc(width * height * 3, 180);
  for (let tile = 0; tile < data.length / 32; tile++) {
    for (let row = 0; row < 8; row++) {
      for (let column = 0; column < 8; column++) {
        const packed = data[tile * 32 + row * 4 + (column >> 1)];
        const value = (packed >> ((column & 1) * 4)) & 15;
        const shade = value === 0 ? 255 : value === 1 ? 0 : 100;
        const destination = (((tile >> 4) * 10 + row) * width + (tile % 16) * 10 + column) * 3;
        pixels.fill(shade, destination, destination + 3);
      }
    }
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rom = readRom(process.argv[2]);
  inspectRom(rom);
  mkdirSync('build', { recursive: true });
  for (const offset of [0x2f8ecc, 0x2f9878]) {
    const decoded = decodePairs(rom, offset);
    const prefix = `build/font-${offset.toString(16)}`;
    writeFileSync(`${prefix}.bin`, decoded.data);
    writeFileSync(`${prefix}.ppm`, tileSheet(decoded.data));
    console.log(`${prefix}: ${decoded.data.length} bytes, ${decoded.consumed} compressed bytes`);
  }
}