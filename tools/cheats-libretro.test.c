#include "libretro.h"
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char* bios_directory;
static uint8_t* iwram;
static uint8_t* ewram;
static unsigned input_buttons;
static const uint8_t* cartridge;
static enum retro_pixel_format pixel_format;
static uint8_t frame_rgb[240 * 160 * 3];

static bool environment(unsigned command, void* data) {
    switch (command) {
    case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
        *(const char**)data = bios_directory;
        return true;
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        pixel_format = *(enum retro_pixel_format*)data;
        return true;
    case RETRO_ENVIRONMENT_SET_SUPPORT_ACHIEVEMENTS:
        return true;
    case RETRO_ENVIRONMENT_SET_MEMORY_MAPS: {
        const struct retro_memory_map* map = data;
        for (unsigned index = 0; index < map->num_descriptors; index++) {
            const struct retro_memory_descriptor* descriptor = &map->descriptors[index];
            if (descriptor->start == 0x03000000) iwram = descriptor->ptr;
            if (descriptor->start == 0x02000000) ewram = descriptor->ptr;
            if (descriptor->start == 0x08000000) cartridge = descriptor->ptr;
        }
        return true;
    }
    default:
        return false;
    }
}

static void video(const void* data, unsigned width, unsigned height, size_t pitch) {
    if (!getenv("CHEAT_WALK_WANDER") || !data) return;
    assert(width == 240 && height == 160);
    for (unsigned row = 0; row < height; row++) {
        for (unsigned column = 0; column < width; column++) {
            uint32_t pixel = 0;
            bool wide = pixel_format == RETRO_PIXEL_FORMAT_XRGB8888;
            memcpy(&pixel, (const uint8_t*)data + row * pitch + column * (wide ? 4 : 2), wide ? 4 : 2);
            size_t offset = (row * width + column) * 3;
            if (wide) {
                frame_rgb[offset] = pixel >> 16;
                frame_rgb[offset + 1] = pixel >> 8;
                frame_rgb[offset + 2] = pixel;
            } else {
                bool green6 = pixel_format == RETRO_PIXEL_FORMAT_RGB565;
                frame_rgb[offset] = ((pixel >> (green6 ? 11 : 10)) & 31) * 255 / 31;
                frame_rgb[offset + 1] = ((pixel >> 5) & (green6 ? 63 : 31)) * 255 / (green6 ? 63 : 31);
                frame_rgb[offset + 2] = (pixel & 31) * 255 / 31;
            }
        }
    }
}

static size_t audio(const int16_t* data, size_t frames) {
    (void)data;
    return frames;
}

static void poll_input(void) {}

static int16_t input(unsigned port, unsigned device, unsigned index, unsigned button) {
    (void)port; (void)device; (void)index;
    if (button == RETRO_DEVICE_ID_JOYPAD_MASK) return (int16_t)input_buttons;
    return button < 16 && (input_buttons & (1u << button)) != 0;
}

static void* read_bytes(const char* path, size_t* size) {
    FILE* file = fopen(path, "rb");
    assert(file && !fseek(file, 0, SEEK_END));
    long length = ftell(file);
    assert(length > 0 && !fseek(file, 0, SEEK_SET));
    *size = (size_t)length;
    void* bytes = malloc(*size);
    assert(bytes && fread(bytes, 1, *size, file) == *size);
    assert(!fclose(file));
    return bytes;
}

static uint32_t elapsed_time(void) {
    uint32_t value;
    memcpy(&value, iwram + 0x918, sizeof(value));
    return value;
}

static uint16_t instruction(size_t offset) {
    uint16_t value;
    assert(cartridge);
    memcpy(&value, cartridge + offset, sizeof(value));
    return value;
}

int main(int argc, char** argv) {
    assert(argc == 4);
    bios_directory = argv[3];
    retro_set_environment(environment);
    retro_set_video_refresh(video);
    retro_set_audio_sample_batch(audio);
    retro_set_input_poll(poll_input);
    retro_set_input_state(input);
    retro_init();
    struct retro_system_info info;
    retro_get_system_info(&info);
    printf("Core: %s %s\n", info.library_name, info.library_version);
    size_t rom_size, snapshot_size;
    void* rom = read_bytes(argv[1], &rom_size);
    struct retro_game_info game = {.path = argv[1], .data = rom, .size = rom_size};
    assert(retro_load_game(&game));
    retro_run();
    if (getenv("CHEAT_WALK_PROBE")) {
        assert(instruction(0x117a) == 0xd026);
        assert(instruction(0x13bf4) == 0xd200);
        retro_cheat_reset();
        retro_cheat_set(5, true, "600008BD 0000E026");
        for (unsigned frame = 0; frame < 5; frame++) retro_run();
        retro_reset();
        assert(instruction(0x117a) == 0xe026);
        assert(instruction(0x13bf4) == 0xd200);
        puts("PASS libretro entry 5 applies walking-only E026; old shared gate remains D200");
        retro_cheat_reset();
        printf("After cheat reset: walking instruction=%04x\n", instruction(0x117a));
        retro_unload_game();
        assert(retro_load_game(&game));
        retro_run();
        assert(instruction(0x117a) == 0xd026);
        assert(instruction(0x13bf4) == 0xd200);
        puts("PASS close/reopen restores original walking and shared instructions");
        retro_unload_game();
        retro_deinit();
        free(rom);
        return 0;
    }
    void* snapshot = read_bytes(argv[2], &snapshot_size);
    if (getenv("CHEAT_WALK_REPLAY")) {
        assert(ewram);
        for (unsigned phase = 0; phase < 3; phase++) {
            if (phase) {
                retro_unload_game();
                assert(retro_load_game(&game));
                retro_run();
            }
            assert(retro_unserialize(snapshot, snapshot_size));
            retro_cheat_reset();
            retro_cheat_set(4, true, "08016568:46C0");
            if (phase == 1) retro_cheat_set(5, true, "600008BD 0000E026");
            unsigned changes = 0;
            unsigned arithmetic_selections = 0;
            unsigned previous = ewram[0x5a0];
            const unsigned directions[] = {RETRO_DEVICE_ID_JOYPAD_RIGHT, RETRO_DEVICE_ID_JOYPAD_LEFT};
            bool wander = getenv("CHEAT_WALK_WANDER") != NULL;
            unsigned duration = wander ? 6600 : 14400;
            for (unsigned frame = 0; frame < duration; frame++) {
                input_buttons = 1u << directions[(frame / 90) % 2];
                if (wander) {
                    const unsigned route[] = {RETRO_DEVICE_ID_JOYPAD_DOWN, RETRO_DEVICE_ID_JOYPAD_RIGHT,
                        RETRO_DEVICE_ID_JOYPAD_DOWN, RETRO_DEVICE_ID_JOYPAD_LEFT,
                        RETRO_DEVICE_ID_JOYPAD_UP, RETRO_DEVICE_ID_JOYPAD_RIGHT};
                    unsigned step = frame < 1080 ? 0 : 1 + (frame - 1080) / 240;
                    input_buttons = frame < 180 ? 0 : 1u << route[step % 6];
                }
                retro_run();
                unsigned current = ewram[0x5a0];
                if (current != previous) {
                    changes++;
                    if (current == 28) arithmetic_selections++;
                }
                previous = current;
            }
            input_buttons = 0;
            if (wander) {
                char filename[128];
                snprintf(filename, sizeof(filename), "build/encounter-libretro-%u.ppm", phase);
                FILE* screenshot = fopen(filename, "wb");
                assert(screenshot);
                assert(fprintf(screenshot, "P6\n240 160\n255\n") > 0);
                assert(fwrite(frame_rgb, 1, sizeof(frame_rgb), screenshot) == sizeof(frame_rgb));
                assert(!fclose(screenshot));
            }
            printf("libretro walking phase=%u eventConfigChanges=%u arithmeticSelections=%u map=%u\n",
                phase, changes, arithmetic_selections, ewram[0x1a8]);
            fflush(stdout);
            if (phase == 1) assert(changes == 0 && arithmetic_selections == 0);
            else assert(changes > 0);
        }
        retro_unload_game();
        retro_deinit();
        free(snapshot);
        free(rom);
        puts("PASS libretro input-only replay: automatic event selection suppressed only while enabled");
        return 0;
    }
    assert(iwram && retro_unserialize(snapshot, snapshot_size));
    uint32_t before = elapsed_time();
    for (unsigned frame = 0; frame < 60; frame++) retro_run();
    printf("Unmodified timer: %u -> %u\n", before, elapsed_time());
    assert(elapsed_time() == before + 60);
    retro_cheat_reset();
    retro_cheat_set(0, true, "08016568:46C0");
    for (unsigned frame = 0; frame < 5; frame++) retro_run();
    before = elapsed_time();
    for (unsigned frame = 0; frame < 120; frame++) retro_run();
    printf("Enabled for 120 frames: timer=%u -> %u\n", before, elapsed_time());
    bool frozen = elapsed_time() == before;
    retro_cheat_reset();
    before = elapsed_time();
    for (unsigned frame = 0; frame < 60; frame++) retro_run();
    printf("Cleared for 60 frames: timer=%u -> %u\n", before, elapsed_time());
    retro_unload_game();
    retro_deinit();
    free(snapshot);
    free(rom);
    return frozen ? 0 : 1;
}