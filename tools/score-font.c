#include <stdint.h>

#define REG16(address) (*(volatile uint16_t*)(address))
#define REG32(address) (*(volatile uint32_t*)(address))

extern const uint32_t timing_marker[];
extern const uint32_t even_marker[];
extern const uint32_t score_copy_code[96];
extern const uint32_t race_copy_code[32];
extern const uint32_t arithmetic_copy_code[32];

int score_cache_active(void) {
    if (REG16(0x04000000) & 7) return 0;
    unsigned layer;
    const uint32_t* marker;
    unsigned arithmetic = *(volatile uint8_t*)0x020005a0 == 28;
    if (arithmetic && REG16(0x0400000a) == 0x1643 &&
        REG16(0x0400000c) == 0x1742 && REG16(0x0400000e) == 0x170a) {
        layer = 0;
        marker = even_marker;
    } else if (*(volatile uint8_t*)0x020005a0 == 0 && REG16(0x0400000a) == 0x1703 &&
        REG16(0x0400000e) == 0) {
        layer = 0;
        marker = even_marker;
    } else if (*(volatile uint8_t*)0x020005a0 == 11 && REG16(0x0400000a) == 0x1702 &&
               REG16(0x0400000e) == 0x1603) {
        layer = 2;
        marker = timing_marker;
    } else if (*(volatile uint8_t*)0x020005a0 == 15 && REG16(0x0400000a) == 0x1643 &&
               (REG16(0x0400000e) == 0 || REG16(0x0400000e) == 0x1204)) {
        layer = 2;
        marker = even_marker;
    } else return 0;
    unsigned config = REG16(0x04000008 + layer * 2);
    if (arithmetic) {
        if (config != 0x1f0c && config != 0x1508) return 0;
    } else if (config != 0x1f0d && config != 0x1409) return 0;
    for (unsigned index = 0; index < 8; index++) {
        if (REG32(0x0600edc0 + index * 4) != marker[index]) return 0;
    }
    return layer + 1;
}

static int overlaps(unsigned start, unsigned size, unsigned cache) {
    return (start < cache + 0x800 && start + size > cache) ||
           (start < 0xa800 && start + size > 0xa000);
}

static __attribute__((noinline)) int copy_map(const volatile uint32_t* extra_map) {
    uint32_t copy_code[96];
    for (unsigned index = 0; index < 96; index++) copy_code[index] = score_copy_code[index];
    return ((int (*)(const volatile uint16_t*, volatile uint16_t*, const volatile uint32_t*, unsigned))copy_code)(
        (const volatile uint16_t*)0x0600f800, (volatile uint16_t*)0x0600a000, extra_map, 0x180);
}

static __attribute__((noinline)) void commit_frame(unsigned active) {
    unsigned text_layer = active - 1;
    unsigned race = *(volatile uint8_t*)0x020005a0 == 15;
    unsigned cache = race ? 0x9800 : 0x9000;
    if (REG16(0x04000006) > 195) {
        while (REG16(0x04000006) >= 160) {}
        while (REG16(0x04000006) < 160) {}
    }
    unsigned display = REG16(0x04000000);
    const volatile uint32_t* extra_map = 0;
    for (unsigned layer = 0; layer < 4; layer++) {
        if (layer == text_layer || !(display & (0x100 << layer))) continue;
        unsigned config = REG16(0x04000008 + layer * 2);
        unsigned map = ((config >> 8) & 31) * 0x800;
        unsigned size = 0x800 << (((config >> 14) & 1) + ((config >> 15) & 1));
        unsigned base = ((config >> 2) & 3) * 0x4000;
        unsigned tile_size = (config & 0x80) ? 64 : 32;
        if (map + size > 0x10000 || overlaps(map, size, cache)) return;
        if (!overlaps(base, 1024 * tile_size, cache)) continue;
        if (race && layer == 3 && config == 0x1204) {
            extra_map = (const volatile uint32_t*)(0x06000000 + map);
            continue;
        }
          if (!((text_layer == 2 && layer == 0 && config == 0x1508) ||
              (text_layer == 0 && layer == 2 && config == 0x1608))) return;
          extra_map = (const volatile uint32_t*)(0x06000000 + map);
    }
    int copied = 1;
    if (race) {
        uint32_t copy_code[32];
        for (unsigned index = 0; index < 32; index++) copy_code[index] = race_copy_code[index];
        copied = ((int (*)(const volatile uint16_t*, volatile uint16_t*, const volatile uint32_t*))copy_code)(
            (const volatile uint16_t*)0x0600f800, (volatile uint16_t*)0x0600a000, extra_map);
    } else copied = copy_map(extra_map);
    if (!copied) return;
    REG16(0x04000008 + text_layer * 2) = 0x1409;
}

static __attribute__((noinline)) int arithmetic_frame(void) {
    if (REG16(0x04000006) > 195) return 0;
    uint32_t copy_code[32];
    for (unsigned index = 0; index < 32; index++) copy_code[index] = arithmetic_copy_code[index];
    int copied = ((int (*)(const volatile uint16_t*, volatile uint16_t*, const volatile uint16_t*))copy_code)(
        (const volatile uint16_t*)0x0600f800, (volatile uint16_t*)0x0600a800,
        (const volatile uint16_t*)0x0600b800);
    if (copied) REG16(0x04000008) = 0x1508;
    return copied;
}

int score_frame(void) {
    unsigned active = score_cache_active();
    if (active && REG16(0x04000006) >= 160) {
        if (*(volatile uint8_t*)0x020005a0 == 28) return arithmetic_frame();
        else commit_frame(active);
    }
    return 0;
}