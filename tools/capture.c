#include <mgba/core/core.h>
#include <mgba-util/vfs.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int dump_memory(struct mCore* core, const char* prefix, const char* suffix,
                       uint32_t address, size_t size) {
    char path[4096];
    int path_length = snprintf(path, sizeof(path), "%s.%s", prefix, suffix);
    if (path_length < 0 || (size_t)path_length >= sizeof(path)) return 0;
    FILE* output = fopen(path, "wb");
    if (!output) return 0;
    for (size_t offset = 0; offset < size; offset++) {
        if (fputc(core->busRead8(core, address + offset), output) == EOF) {
            fclose(output);
            return 0;
        }
    }
    return fclose(output) == 0;
}

int main(int argc, char** argv) {
    if (argc < 4) {
        fprintf(stderr, "Usage: capture ROM OUTPUT_PREFIX FRAMES:KEY_MASK [...]\n"
            "Test-only steps: patch32:HEX_ADDRESS:HEX_EXPECTED:HEX_VALUE\n"
            "                poke16:HEX_EWRAM_ADDRESS:HEX_EXPECTED:HEX_VALUE\n");
        return 1;
    }
    struct mCore* core = mCoreFind(argv[1]);
    if (!core || !core->init(core)) return 1;
    mCoreInitConfig(core, NULL);
    if (!mCoreLoadFile(core, argv[1])) {
        core->deinit(core);
        return 1;
    }
    unsigned width = 0;
    unsigned height = 0;
    core->desiredVideoDimensions(core, &width, &height);
    color_t* pixels = calloc((size_t)width * height, sizeof(color_t));
    if (!pixels) {
        core->deinit(core);
        return 1;
    }
    core->setVideoBuffer(core, pixels, width);
    core->reset(core);
    for (int index = 3; index < argc; index++) {
        if (strncmp(argv[index], "poke16:", 7) == 0) {
            unsigned address = 0;
            unsigned expected = 0;
            unsigned value = 0;
            char extra;
            if (sscanf(argv[index], "poke16:%x:%x:%x%c", &address, &expected, &value, &extra) != 3 ||
                address < 0x02000000 || address > 0x0203fffe || (address & 1) ||
                expected > 0xffff || value > 0xffff || core->busRead16(core, address) != expected) {
                fprintf(stderr, "Invalid test RAM write or original value mismatch: %s\n", argv[index]);
                core->deinit(core);
                free(pixels);
                return 1;
            }
            core->busWrite16(core, address, value);
            if (core->busRead16(core, address) != value) {
                fprintf(stderr, "Test RAM write did not take effect.\n");
                core->deinit(core);
                free(pixels);
                return 1;
            }
            fprintf(stderr, "test-only RAM write %08x: %04x -> %04x\n", address, expected, value);
            continue;
        }
        if (strncmp(argv[index], "patch32:", 8) == 0) {
            unsigned address = 0;
            unsigned expected = 0;
            unsigned value = 0;
            char extra;
            if (sscanf(argv[index], "patch32:%x:%x:%x%c", &address, &expected, &value, &extra) != 3 ||
                address < 0x08000000 || address > 0x09fffffc || (address & 3) ||
                core->rawRead32(core, address, -1) != expected) {
                fprintf(stderr, "Invalid test patch or original value mismatch: %s\n", argv[index]);
                core->deinit(core);
                free(pixels);
                return 1;
            }
            core->rawWrite32(core, address, -1, value);
            if (core->rawRead32(core, address, -1) != value) {
                fprintf(stderr, "Test patch did not take effect.\n");
                core->deinit(core);
                free(pixels);
                return 1;
            }
            fprintf(stderr, "test-only ROM patch %08x: %08x -> %08x\n", address, expected, value);
            continue;
        }
        unsigned frames = 0;
        unsigned keys = 0;
        char extra;
        if (sscanf(argv[index], "%u:%u%c", &frames, &keys, &extra) != 2 ||
            frames > 36000 || keys > 1023) {
            fprintf(stderr, "Invalid input step: %s\n", argv[index]);
            core->deinit(core);
            free(pixels);
            return 1;
        }
        core->setKeys(core, keys);
        for (unsigned frame = 0; frame < frames; frame++) {
            core->runFrame(core);
            if (frame == 0 && (core->busRead16(core, 0x04000130) & 1023) != (keys ^ 1023)) {
                fprintf(stderr, "Keypad state does not match requested input.\n");
                core->deinit(core);
                free(pixels);
                return 1;
            }
        }
        fprintf(stderr, "frames=%u requested=%u hardware=%u game=%u\n", frames, keys,
                core->busRead16(core, 0x04000130) ^ 1023,
                core->busRead16(core, 0x03001be0));
    }
    char path[4096];
    int path_length = snprintf(path, sizeof(path), "%s.png", argv[2]);
    int success = path_length >= 0 && (size_t)path_length < sizeof(path);
    struct VFile* screenshot = success ? VFileOpen(path, O_WRONLY | O_CREAT | O_TRUNC) : NULL;
    success = screenshot && mCoreTakeScreenshotVF(core, screenshot);
    if (screenshot) screenshot->close(screenshot);
    success = success && dump_memory(core, argv[2], "ewram", 0x02000000, 0x40000);
    success = success && dump_memory(core, argv[2], "iwram", 0x03000000, 0x8000);
    success = success && dump_memory(core, argv[2], "vram", 0x06000000, 0x18000);
    success = success && dump_memory(core, argv[2], "io", 0x04000000, 0x60);
    core->deinit(core);
    free(pixels);
    if (!success) fprintf(stderr, "Could not write capture outputs.\n");
    return success ? 0 : 1;
}