#include <stdint.h>

#define REG16(address) (*(volatile uint16_t*)(address))
#define REG32(address) (*(volatile uint32_t*)(address))

extern const uint16_t preview_pages[];
extern const uint16_t preview_backup[];

static void wait_blank(void) {
    while (REG16(0x04000006) >= 160) {}
    while (REG16(0x04000006) < 160) {}
}

static void copy_halfwords(volatile uint16_t* destination, const volatile uint16_t* source, unsigned count) {
    for (unsigned index = 0; index < count; index++) destination[index] = source[index];
}

static int overlaps(unsigned start, unsigned size) {
    return (start < 0xa200 && start + size > 0x9000) ||
           (start < 0xb000 && start + size > 0xa800);
}

static int house_available(void) {
    if (REG32(0x03000080) != 0x08155ddc || REG16(0x04000000) != 0x1740 ||
        REG16(0x04000008) != 0x1f0c || REG16(0x0400000a) != 0x1643 ||
        REG16(0x0400000c) != 0x1742 || REG16(0x0400000e) != 0) return 0;
    for (unsigned index = 0; index < 16; index++) {
        if (REG16(0x0600c000 + index * 2)) return 0;
    }
    for (unsigned row = 8; row < 14; row++) {
        for (unsigned column = 3; column < 27; column++) {
            if (REG16(0x0600f800 + (row * 32 + column) * 2) != 0xf000) return 0;
        }
    }
    for (unsigned layer = 0; layer < 3; layer++) {
        unsigned config = REG16(0x04000008 + layer * 2);
        unsigned map = ((config >> 8) & 31) * 0x800;
        unsigned base = ((config >> 2) & 3) * 0x4000;
        if (overlaps(map, 0x800)) return 0;
        for (unsigned entry = 0; entry < 1024; entry++) {
            unsigned tile = REG16(0x06000000 + map + entry * 2) & 1023;
            unsigned address = base + tile * 32;
            if (address < 0x10000 && overlaps(address, 32)) return 0;
        }
    }
    for (unsigned index = 0; index < 2304; index++) {
        if (REG16(0x06009000 + index * 2) != preview_backup[index]) return 0;
    }
    for (unsigned index = 0; index < 1024; index++) {
        if (REG16(0x0600a800 + index * 2) != preview_backup[2304 + index]) return 0;
    }
    return 1;
}

__attribute__((noinline)) static void show_preview(void) {
    volatile uint16_t* canvas = (volatile uint16_t*)0x06009000;
    volatile uint16_t* map = (volatile uint16_t*)0x0600a800;
    uint16_t display = REG16(0x04000000);
    uint16_t config = REG16(0x0400000e);
    uint16_t interrupts = REG16(0x04000208);
    REG16(0x04000208) = 0;
    wait_blank();
    copy_halfwords(canvas, preview_pages, 2304);
    for (unsigned entry = 0; entry < 1024; entry++) map[entry] = 0xf200;
    for (unsigned row = 0; row < 6; row++) {
        for (unsigned column = 0; column < 24; column++) {
            map[(row + 8) * 32 + column + 3] = 0xf080 + row * 24 + column;
        }
    }
    REG16(0x0400000e) = 0x1509;
    REG16(0x0400001c) = 0;
    REG16(0x0400001e) = 0;
    REG16(0x04000000) = display | 0x800;
    unsigned previous = 0x3ff;
    unsigned page = 0;
    for (;;) {
        wait_blank();
        unsigned pressed = (~REG16(0x04000130)) & 0x3ff;
        unsigned edge = pressed & ~previous;
        previous = pressed;
        if ((edge & 2) || ((edge & 1) && page == 6)) break;
        if (edge & 1) {
            page++;
            copy_halfwords(canvas, preview_pages + page * 2304, 2304);
        }
    }
    REG16(0x04000000) = display;
    copy_halfwords(canvas, preview_backup, 2304);
    copy_halfwords(map, preview_backup + 2304, 1024);
    REG16(0x0400000e) = config;
    REG16(0x0400001c) = 0;
    REG16(0x0400001e) = 0;
    while (((~REG16(0x04000130)) & 0x303) != 0) wait_blank();
    REG16(0x04000208) = interrupts;
}

void preview_tick(void) {
    if (((~REG16(0x04000130)) & 0x300) != 0x300) return;
    if (!house_available()) return;
    show_preview();
}