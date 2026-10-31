#define main host_preview_main
#include "../build/tenpx-preview.c"
#undef main

static struct mCore* diagnostic_core;

static void test_log(struct mLogger* logger, int category, enum mLogLevel level,
                     const char* format, va_list arguments) {
    (void)logger;
    (void)category;
    if (!(level & (mLOG_FATAL | mLOG_ERROR)) && !strstr(format, "Illegal opcode")) return;
    vfprintf(stderr, format, arguments);
    uint32_t program_counter = 0;
    uint32_t stack_pointer = 0;
    diagnostic_core->readRegister(diagnostic_core, "pc", &program_counter);
    diagnostic_core->readRegister(diagnostic_core, "sp", &stack_pointer);
    fprintf(stderr, " PC=%08x SP=%08x\n", program_counter, stack_pointer);
    exit(1);
}

static void live_frames(struct Preview* preview, unsigned count, unsigned keys) {
    preview->live.core->setKeys(preview->live.core, keys);
    for (unsigned frame = 0; frame < count; frame++) preview->live.core->runFrame(preview->live.core);
}

int main(int argc, char** argv) {
    if (argc != 4) return 1;
    size_t rom_size = 0;
    size_t page_size = 0;
    uint8_t* rom = read_input(argv[1], 0x800000, &rom_size);
    uint8_t* pages = read_input(argv[2], 7 * PAGE_BYTES, &page_size);
    if (!rom || !pages || page_size != 7 * PAGE_BYTES) return 1;
    struct Preview* preview = calloc(1, sizeof(*preview));
    if (!preview || !initialize(&preview->live, rom, rom_size) || !initialize(&preview->control, rom, rom_size)) return 1;
    diagnostic_core = preview->live.core;
    struct mLogger logger = {.log = test_log, .filter = NULL};
    mLogSetDefaultLogger(&logger);
    run_frames(preview, 900, 0);
    run_frames(preview, 2, 8);
    run_frames(preview, 180, 0);
    run_frames(preview, 2, 8);
    run_frames(preview, 180, 0);
    run_frames(preview, 2, 1);
    run_frames(preview, 1500, 0);
    for (unsigned press = 0; press < 100; press++) {
        run_frames(preview, 2, 1);
        run_frames(preview, 90, 0);
    }
    run_frames(preview, 240, 0);
    for (unsigned offset = 0; offset < 0x60; offset += 2) preview->original_io[offset / 2] = reg_value(&preview->live, offset);
    if (!native_scene(&preview->live, 0)) return 1;
    read_bytes(&preview->live, 0x06009000, preview->original_canvas, PAGE_BYTES);
    read_bytes(&preview->live, 0x0600a800, preview->original_map, 0x800);
    for (unsigned entry = 0; entry < 1024; entry++) {
        unsigned row = entry / 32;
        unsigned column = entry % 32;
        unsigned value = row >= 8 && row < 14 && column >= 3 && column < 27 ?
            0xf080 + (row - 8) * 24 + column - 3 : 0xf200;
        preview->overlay_map[entry * 2] = value & 255;
        preview->overlay_map[entry * 2 + 1] = value >> 8;
    }
    if (!screenshot(&preview->live, argv[3], "before.png")) return 1;
    uint32_t stack_pointer = 0;
    preview->live.core->readRegister(preview->live.core, "sp", &stack_pointer);
    fprintf(stderr, "Before preview: SP=%08x\n", stack_pointer);
    live_frames(preview, 3, 0x300);
    live_frames(preview, 3, 0);
        uint32_t program_counter = 0;
        preview->live.core->readRegister(preview->live.core, "pc", &program_counter);
        preview->live.core->readRegister(preview->live.core, "sp", &stack_pointer);
        fprintf(stderr, "After entry: PC=%08x SP=%08x DISP=%04x BG3=%04x IME=%04x\n", program_counter,
            stack_pointer, reg_value(&preview->live, 0), reg_value(&preview->live, 0x0e),
            preview->live.core->busRead16(preview->live.core, 0x04000208));
    for (unsigned page = 0; page < 7; page++) {
        for (unsigned frame = 0; frame < 120; frame++) {
            live_frames(preview, 1, 0);
            if (!validate(preview, pages + page * PAGE_BYTES, 1)) return 1;
        }
        char suffix[40];
        snprintf(suffix, sizeof(suffix), "page-%u.png", page + 1);
        if (!screenshot(&preview->live, argv[3], suffix)) return 1;
        live_frames(preview, 2, 1);
        if (page == 6 && (!validate(preview, NULL, 1) ||
            !screenshot(&preview->live, argv[3], "restored.png"))) return 1;
        live_frames(preview, 3, 0);
    }
    live_frames(preview, 120, 0);
    if (!native_scene(&preview->live, 0)) return 1;
    uint8_t* reopened_vram = malloc(VRAM_BYTES);
    if (!reopened_vram) return 1;
    read_bytes(&preview->live, 0x06000000, reopened_vram, VRAM_BYTES);
    live_frames(preview, 3, 0x300);
    live_frames(preview, 3, 0);
    if (!native_scene(&preview->live, 1)) return 1;
    for (unsigned offset = 0; offset < PAGE_BYTES; offset++) {
        if (byte_value(&preview->live, 0x06009000 + offset) != pages[offset]) return 1;
    }
    live_frames(preview, 2, 2);
    if (!native_scene(&preview->live, 0)) return 1;
    for (unsigned offset = 0; offset < VRAM_BYTES; offset++) {
        if (byte_value(&preview->live, 0x06000000 + offset) != reopened_vram[offset]) return 1;
    }
    free(reopened_vram);
    live_frames(preview, 120, 0);
    for (unsigned press = 0; press < 20; press++) {
        live_frames(preview, 2, 1);
        live_frames(preview, 120, 0);
    }
    if (preview->live.core->busRead32(preview->live.core, 0x03000080) == 0x08155ddc) return 1;
    if (!screenshot(&preview->live, argv[3], "continued.png")) return 1;
    printf("PASS ROM-only inputs: 7 pages, 840 pixel-checked frames, exact VRAM restoration, reopen/B exit, continued game.\n");
    preview->live.core->deinit(preview->live.core);
    preview->control.core->deinit(preview->control.core);
    free(preview->live.pixels);
    free(preview->control.pixels);
    free(preview);
    free(rom);
    free(pages);
    return 0;
}