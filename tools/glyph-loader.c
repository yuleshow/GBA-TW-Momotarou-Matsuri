#include <stdint.h>

extern const uint32_t chinese_glyphs[];
extern const uint32_t chinese_glyph_count;

#ifndef GLYPH_CACHE
#define GLYPH_CACHE ((volatile uint32_t*)0x0600e000)
#endif
#ifndef GLYPH_MAP
#define GLYPH_MAP ((volatile uint16_t*)0x0600f800)
#endif
#ifndef GLYPH_SLOTS
#define GLYPH_SLOTS 64
#endif

#ifdef SCORE_CACHE
extern int score_cache_active(void);
#ifndef SCORE_GLYPH_CACHE
#define SCORE_GLYPH_CACHE ((volatile uint32_t*)0x06009000)
#endif
#endif

uint32_t chinese_tile(uint8_t** text, uint32_t code, uint32_t bank) {
    if (code != 2 || bank != 0) return code + bank;
    const uint8_t* cursor = *text;
    uint32_t high = cursor[1];
    uint32_t low = cursor[2];
    if (high < 0x40 || high > 0x7f || low < 0x40 || low > 0x7f) return 0x3f;
    uint32_t glyph = (high - 0x40) * 64 + low - 0x40;
    *text += 2;
    if (glyph >= chinese_glyph_count) return 0x3f;
    const uint32_t* source = chinese_glyphs + glyph * 8;
    volatile uint32_t* cache = GLYPH_CACHE;
    uint32_t first_tile = 0x100;
#ifdef SCORE_CACHE
    if (score_cache_active()) {
        cache = SCORE_GLYPH_CACHE;
        if (*(volatile uint8_t*)0x020005a0 == 15) cache = (volatile uint32_t*)0x06009800;
        if (*(volatile uint8_t*)0x020005a0 == 28) cache = (volatile uint32_t*)0x0600a000;
        first_tile = 0x200;
    }
#endif
    for (uint32_t slot = 0; slot < GLYPH_SLOTS; slot++) {
        uint32_t word = 0;
        while (word < 8 && cache[slot * 8 + word] == source[word]) word++;
        if (word == 8) return first_tile + slot;
    }
    volatile uint32_t used[GLYPH_SLOTS / 32];
    for (uint32_t index = 0; index < GLYPH_SLOTS / 32; index++) used[index] = 0;
    volatile uint16_t* map = GLYPH_MAP;
    for (uint32_t index = 0; index < 1024; index++) {
        uint32_t tile = map[index] & 0x3ff;
        if (tile >= first_tile && tile < first_tile + GLYPH_SLOTS) {
            uint32_t slot = tile - first_tile;
            used[slot >> 5] |= 1u << (slot & 31);
        }
    }
    for (uint32_t slot = 0; slot < GLYPH_SLOTS; slot++) {
        if ((used[slot >> 5] & (1u << (slot & 31))) != 0) continue;
        for (uint32_t word = 0; word < 8; word++) cache[slot * 8 + word] = source[word];
        return first_tile + slot;
    }
    return 0x3f;
}