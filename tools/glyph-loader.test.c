#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

#ifndef GLYPH_SLOTS
#define GLYPH_SLOTS 64
#endif
static uint32_t cache_memory[GLYPH_SLOTS * 8];
static uint16_t map_memory[1024];
#ifdef SCORE_CACHE
static uint32_t score_memory[GLYPH_SLOTS * 8];
static int score_active;
#define SCORE_GLYPH_CACHE score_memory
int score_cache_active(void) { return score_active; }
#endif
#define GLYPH_CACHE cache_memory
#define GLYPH_MAP map_memory
#include "glyph-loader.c"

const uint32_t chinese_glyph_count = 130;
const uint32_t chinese_glyphs[130 * 8] = {
    [0] = 0x12121212,
    [65 * 8] = 0x22222222,
    [129 * 8] = 0x21212121,
};

int main(void) {
    uint8_t encoded[] = {2, 0x42, 0x41, 0};
    uint8_t* cursor = encoded;
    uint32_t tile = chinese_tile(&cursor, 2, 0);
    assert(tile == 0x100);
    assert(cursor == encoded + 2);
    assert(cache_memory[0] == 0x21212121);
    map_memory[0] = tile | 0xf000;
    cursor = encoded;
    assert(chinese_tile(&cursor, 2, 0) == tile);

    encoded[1] = 0x41;
    cursor = encoded;
    assert(chinese_tile(&cursor, 2, 0) == 0x101);
    assert(cache_memory[0] == 0x21212121);
    assert(cache_memory[8] == 0x22222222);
    memset(map_memory, 0, sizeof(map_memory));
    encoded[1] = 0x40;
    encoded[2] = 0x40;
    cursor = encoded;
    assert(chinese_tile(&cursor, 2, 0) == 0x100);
    assert(cache_memory[0] == 0x12121212);

    memset(cache_memory, 0xff, sizeof(cache_memory));
    for (uint32_t slot = 0; slot < GLYPH_SLOTS; slot++) map_memory[slot] = 0xf100 + slot;
    uint32_t before[GLYPH_SLOTS * 8];
    memcpy(before, cache_memory, sizeof(before));
    cursor = encoded;
    assert(chinese_tile(&cursor, 2, 0) == 0x3f);
    assert(memcmp(before, cache_memory, sizeof(before)) == 0);

    cursor = encoded;
    assert(chinese_tile(&cursor, 0x80, 0x100) == 0x180);
    assert(cursor == encoded);
    encoded[1] = 0x7f;
    encoded[2] = 0x7f;
    assert(chinese_tile(&cursor, 2, 0) == 0x3f);
    encoded[1] = 0x20;
    cursor = encoded;
    assert(chinese_tile(&cursor, 2, 0) == 0x3f);
    assert(cursor == encoded);
#ifdef SCORE_CACHE
    score_active = 1;
    encoded[1] = 0x40;
    encoded[2] = 0x40;
    memset(map_memory, 0, sizeof(map_memory));
    memcpy(before, cache_memory, sizeof(before));
    cursor = encoded;
    assert(chinese_tile(&cursor, 2, 0) == 0x200);
    assert(score_memory[0] == 0x12121212);
    assert(memcmp(before, cache_memory, sizeof(before)) == 0);
    map_memory[0] = 0xf200;
    encoded[1] = 0x41;
    encoded[2] = 0x41;
    cursor = encoded;
    assert(chinese_tile(&cursor, 2, 0) == 0x201);
    assert(score_memory[0] == 0x12121212);
    assert(memcmp(before, cache_memory, sizeof(before)) == 0);
#endif
    puts("PASS: extended IDs, reuse, visible-tile protection, eviction, exhaustion and Japanese passthrough");
    return 0;
}