#include <mgba/core/core.h>
#include <mgba/core/cheats.h>
#include <mgba/core/log.h>
#include <mgba/core/serialize.h>
#include <mgba/debugger/debugger.h>
#include <mgba/internal/arm/isa-inlines.h>
#include <mgba-util/vfs.h>
#include <assert.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>

static unsigned tested_mode;
static unsigned injected;
static unsigned verified;
static unsigned walking_checks;
static unsigned walking_entries;
static unsigned walking_started;
static unsigned walking_trace_count;

static void walking_encounters(struct mCore* core, bool disabled, bool active, bool moving, bool changed_tile) {
    core->busWrite16(core, 0x04000208, 0);
    _ARMSetMode(core->cpu, MODE_THUMB);
    uint32_t address = 0x0800116c;
    uint32_t active_value = active;
    uint32_t movement = moving ? 4 : 0;
    uint32_t tile = changed_tile;
    assert(core->writeRegister(core, "r8", &active_value));
    assert(core->writeRegister(core, "r9", &movement));
    assert(core->writeRegister(core, "r7", &tile));
    assert(core->writeRegister(core, "pc", &address));
    for (unsigned step = 0; step < 30; step++) {
        core->step(core);
        uint32_t pc = 0;
        assert(core->readRegister(core, "pc", &pc));
        if (pc == 0x08001182 || pc == 0x080011cc || pc == 0x0800120e) {
            uint32_t expected = !active ? 0x0800120e :
                disabled || !moving || !changed_tile ? 0x080011cc : 0x08001182;
            assert(pc == expected);
            return;
        }
    }
    assert(!"Walking encounter check did not reach its expected boundary");
}

static void field_dispatch(struct mCore* core, bool disabled, unsigned flags) {
    core->busWrite16(core, 0x04000208, 0);
    _ARMSetMode(core->cpu, MODE_THUMB);
    uint32_t stack = 0;
    uint32_t address = 0x08000ee4;
    uint32_t game = 28;
    uint32_t terrain = 1;
    uint32_t link = 0x08041de1;
    core->busWrite16(core, 0x03005b4c, flags);
    core->busWrite32(core, 0x020007f4, 638);
    assert(core->readRegister(core, "sp", &stack));
    assert(core->writeRegister(core, "r0", &game));
    assert(core->writeRegister(core, "r1", &terrain));
    assert(core->writeRegister(core, "lr", &link));
    assert(core->writeRegister(core, "pc", &address));
    for (unsigned step = 0; step < 2000; step++) {
        core->step(core);
        uint32_t pc = 0;
        assert(core->readRegister(core, "pc", &pc));
        if (pc == 0x08013bfa) {
            printf("field dispatch: disabled=%u flags=%04x reached encounter initialization\n", disabled, flags);
            fflush(stdout);
            assert(!disabled);
            assert(core->writeRegister(core, "sp", &stack));
            return;
        }
        if (pc == 0x08041de2) {
            uint32_t result = 1;
            uint32_t returned_stack = 0;
            assert(disabled);
            assert(core->readRegister(core, "r0", &result));
            assert(core->readRegister(core, "sp", &returned_stack));
            assert(result == 0 && returned_stack == stack);
            return;
        }
    }
    assert(!"Field dispatch did not reach its expected boundary");
}

static void encounter_gate(struct mCore* core, unsigned game, unsigned forced, bool disabled) {
    core->busWrite16(core, 0x04000208, 0);
    _ARMSetMode(core->cpu, MODE_THUMB);
    uint32_t stack = 0;
    uint32_t argument = 0x020005a0;
    uint32_t address = 0x08013b9c;
    uint32_t link = 0x08041de1;
    uint32_t prerequisite = 0x1d6;
    uint32_t probability = forced == 1 ? 0xffff : 255;
    core->busWrite8(core, argument, game);
    core->busWrite16(core, 0x03005b4c, forced == 2 ? 0x400 : 0);
    core->busWrite32(core, 0x020007f4, 25);
    assert(core->readRegister(core, "sp", &stack));
    assert(core->writeRegister(core, "r0", &argument));
    assert(core->writeRegister(core, "r1", &prerequisite));
    assert(core->writeRegister(core, "r2", &probability));
    assert(core->writeRegister(core, "lr", &link));
    assert(core->writeRegister(core, "pc", &address));
    bool rolled = false;
    for (unsigned step = 0; step < 1000; step++) {
        core->step(core);
        uint32_t pc = 0;
        assert(core->readRegister(core, "pc", &pc));
        if (pc == 0x08013bf4) rolled = true;
        if (pc == 0x08013bfa) {
            assert(forced || !disabled);
            assert(rolled == !forced);
            assert(core->writeRegister(core, "sp", &stack));
            return;
        }
        if (pc == 0x08041de2) {
            uint32_t result = 1;
            uint32_t returned_stack = 0;
            assert(!forced && disabled && rolled);
            assert(core->readRegister(core, "r0", &result));
            assert(core->readRegister(core, "sp", &returned_stack));
            assert(result == 0 && returned_stack == stack);
            return;
        }
    }
    assert(!"Encounter gate did not reach its expected boundary");
}

static void debugger_noop(struct mDebugger* debugger) { (void)debugger; }

static void walking_entered(struct mDebugger* debugger, enum mDebuggerEntryReason reason,
                            struct mDebuggerEntryInfo* info) {
    if (reason == DEBUGGER_ENTER_BREAKPOINT) {
        if (info->address == 0x0800117a) walking_checks++;
        if (info->address == 0x08001180) walking_entries++;
        if (info->address == (getenv("CHEAT_WALK_TRACE") ? 0x08027d9e : 0x08013bf8)) walking_started++;
        if (getenv("CHEAT_WALK_TRACE") && info->address >= 0x08013b9c && walking_trace_count++ < 40) {
            uint32_t link = 0, argument = 0, probability = 0;
            struct mCore* core = debugger->core;
            assert(core->readRegister(core, "lr", &link));
            assert(core->readRegister(core, "r0", &argument));
            assert(core->readRegister(core, "r2", &probability));
            printf("encounter trace pc=%08x lr=%08x r0=%08x r2=%08x config=%08x terrain=%u flags=%04x walkingPatch=%04x\n",
                info->address, link, argument, probability, core->busRead32(core, 0x020005a0),
                core->busRead8(core, 0x020005a5), core->busRead16(core, 0x03005b4c), core->busRead16(core, 0x0800117a));
        }
    }
    debugger->state = DEBUGGER_RUNNING;
}

static void walking_replay(struct mCore* core, struct mCheatDevice* device, const char* path) {
    static color_t pixels[240 * 160];
    if (getenv("CHEAT_WALK_WANDER")) core->setVideoBuffer(core, pixels, 240);
    struct mDebugger debugger = {.type = DEBUGGER_CUSTOM, .init = debugger_noop,
        .deinit = debugger_noop, .entered = walking_entered, .paused = debugger_noop, .update = debugger_noop};
    mDebuggerAttach(&debugger, core);
    const uint32_t addresses[] = {0x0800117a, 0x08001180, 0x08013bf8, 0x08013b9c, 0x08027d8c, 0x08027d9e};
    for (unsigned index = 0; index < sizeof(addresses) / sizeof(addresses[0]); index++) {
        struct mBreakpoint point = {.address = addresses[index], .segment = -1, .type = BREAKPOINT_HARDWARE};
        assert(debugger.platform->setBreakpoint(debugger.platform, &point) >= 0);
    }
    for (unsigned phase = 0; phase < 3; phase++) {
        core->reset(core);
        struct VFile* snapshot = VFileOpen(path, O_RDONLY);
        assert(snapshot && mCoreLoadStateNamed(core, snapshot, SAVESTATE_RTC));
        snapshot->close(snapshot);
        for (unsigned index = 0; index < mCheatSetsSize(&device->cheats); index++) {
            struct mCheatSet* set = *mCheatSetsGetPointer(&device->cheats, index);
            set->enabled = index == 5 && phase == 1;
            mCheatRefresh(device, set);
        }
        walking_checks = walking_entries = walking_started = 0;
        walking_trace_count = 0;
        debugger.state = DEBUGGER_RUNNING;
        if (getenv("CHEAT_WALK_DELAY")) {
            unsigned delay = strtoul(getenv("CHEAT_WALK_DELAY"), NULL, 10);
            assert(delay <= 3600);
            core->setKeys(core, 0);
            for (unsigned frame = 0; frame < delay; frame++) mDebuggerRunFrame(&debugger);
        }
        const unsigned steps[][2] = {{120, 128}, {900, 128}, {900, 16}, {900, 64}, {900, 32},
            {900, 128}, {900, 16}, {900, 64}, {900, 32}};
        unsigned step_count = getenv("CHEAT_WALK_TRACE") ? 160 : sizeof(steps) / sizeof(steps[0]);
        if (getenv("CHEAT_WALK_WANDER")) step_count = 24;
        for (unsigned step = 0; step < step_count && !walking_started; step++) {
            unsigned keys = getenv("CHEAT_WALK_TRACE") ? (step % 2 ? 32 : 16) : steps[step][1];
            unsigned frames = getenv("CHEAT_WALK_TRACE") ? 90 : steps[step][0];
            if (getenv("CHEAT_WALK_WANDER")) {
                const unsigned directions[] = {128, 16, 128, 32, 64, 16};
                keys = directions[step % 6];
                frames = step ? 240 : 900;
            }
            core->setKeys(core, keys);
            for (unsigned frame = 0; frame < frames && !walking_started; frame++) mDebuggerRunFrame(&debugger);
            if (getenv("CHEAT_WALK_WANDER")) {
                printf("wander phase=%u step=%u map=%u checks=%u started=%u\n", phase, step,
                    core->busRead16(core, 0x020001a8), walking_checks, walking_started);
            }
        }
        if (getenv("CHEAT_WALK_WANDER")) {
            if (walking_started) {
                core->setKeys(core, 0);
                for (unsigned frame = 0; frame < 180; frame++) mDebuggerRunFrame(&debugger);
            }
            char filename[128];
            snprintf(filename, sizeof(filename), "build/encounter-wander-%u.png", phase);
            struct VFile* screenshot = VFileOpen(filename, O_WRONLY | O_CREAT | O_TRUNC);
            assert(screenshot && mCoreTakeScreenshotVF(core, screenshot));
            screenshot->close(screenshot);
        }
        printf("walking replay phase=%u checks=%u entries=%u encounters=%u map=%u\n",
            phase, walking_checks, walking_entries, walking_started, core->busRead16(core, 0x020001a8));
        fflush(stdout);
        if (getenv("CHEAT_WALK_TRACE")) continue;
        assert(walking_checks > 0);
        if (phase == 1) assert(walking_entries == 0 && walking_started == 0);
        else assert(walking_entries > 0);
    }
    core->detachDebugger(core);
    puts(getenv("CHEAT_WALK_TRACE") ? "Completed diagnostic replay (no acceptance assertions)" :
        "PASS input-only walking replay: encounter block entered off/restored, skipped on");
}

static void quiet_log(struct mLogger* logger, int category, enum mLogLevel level,
                      const char* format, va_list args) {
    (void)logger;
    (void)category;
    if (level & (mLOG_ERROR | mLOG_FATAL)) vfprintf(stderr, format, args);
}

static uint32_t call_leaf(struct mCore* core, uint32_t address, uint32_t argument) {
    core->busWrite16(core, 0x04000208, 0);
    _ARMSetMode(core->cpu, MODE_THUMB);
    uint32_t link = 0x08041de1;
    assert(core->writeRegister(core, "r0", &argument));
    assert(core->writeRegister(core, "lr", &link));
    assert(core->writeRegister(core, "pc", &address));
    for (unsigned step = 0; step < 100; step++) {
        core->step(core);
        uint32_t pc = 0;
        assert(core->readRegister(core, "pc", &pc));
        if (pc == 0x08041de2) {
            uint32_t result = 0;
            assert(core->readRegister(core, "r0", &result));
            return result;
        }
    }
    assert(!"Leaf function did not return");
    return 0;
}

static void race_timer_tick(struct mCore* core, bool paused) {
    core->busWrite16(core, 0x04000208, 0);
    _ARMSetMode(core->cpu, MODE_THUMB);
    uint32_t stack = 0;
    uint32_t address = 0x08016550;
    assert(core->readRegister(core, "sp", &stack));
    assert(core->writeRegister(core, "pc", &address));
    for (unsigned step = 0; step < 100; step++) {
        core->step(core);
        uint32_t pc = 0;
        assert(core->readRegister(core, "pc", &pc));
        if (pc == (paused ? 0x08016580u : 0x0801657cu)) {
            assert(core->writeRegister(core, "sp", &stack));
            return;
        }
    }
    assert(!"Race timer did not reach display/scheduler boundary");
}

static void entered(struct mDebugger* debugger, enum mDebuggerEntryReason reason,
                    struct mDebuggerEntryInfo* info) {
    struct mCore* core = debugger->core;
    if (reason == DEBUGGER_ENTER_BREAKPOINT && !verified) {
        if (info->address == 0x08041de0 && !injected) {
            assert(core->busRead16(core, 0x03000228) > 1);
            for (unsigned member = 0; member < 4; member++) {
                unsigned address = 0x03000228 + member * 8;
                core->busWrite16(core, address + 4, core->busRead16(core, address) / 2);
                core->busWrite16(core, address + 6, core->busRead16(core, address + 2) / 2);
            }
            injected = 1;
        }
        if (info->address == 0x08041e2e && injected) {
            for (unsigned member = 0; member < 4; member++) {
                unsigned address = 0x03000228 + member * 8;
                unsigned hp = core->busRead16(core, address);
                unsigned mp = core->busRead16(core, address + 2);
                assert(core->busRead16(core, address + 4) == ((tested_mode & 1) ? hp : hp / 2));
                assert(core->busRead16(core, address + 6) == ((tested_mode & 2) ? mp : mp / 2));
            }
            verified = 1;
        }
    }
    debugger->state = DEBUGGER_RUNNING;
}

int main(void) {
    struct mLogger logger = {.log = quiet_log};
    mLogSetDefaultLogger(&logger);
    const char* rom_path = getenv("CHEAT_TEST_ROM");
    if (!rom_path) rom_path = "build/momotarou-zh-Hant.gba";
    struct mCore* core = mCoreFind(rom_path);
    assert(core && core->init(core));
    mCoreInitConfig(core, NULL);
    assert(mCoreLoadFile(core, rom_path));
    if (getenv("CHEAT_TEST_BIOS")) {
        struct VFile* bios = VFileOpen(getenv("CHEAT_TEST_BIOS"), O_RDONLY);
        assert(bios && core->loadBIOS(core, bios, 0));
    }
    core->reset(core);
    struct mCheatDevice* device = core->cheatDevice(core);
    assert(device);
    device->autosave = false;
    if (getenv("CHEAT_LIBRETRO_PROBE")) {
        if (getenv("CHEAT_RACE_STATE")) {
            struct VFile* snapshot = VFileOpen(getenv("CHEAT_RACE_STATE"), O_RDONLY);
            assert(snapshot && mCoreLoadStateNamed(core, snapshot, SAVESTATE_RTC));
            snapshot->close(snapshot);
            unsigned elapsed = core->busRead32(core, 0x03000918);
            core->setKeys(core, 0);
            for (unsigned frame = 0; frame < 60; frame++) core->runFrame(core);
            assert(core->busRead32(core, 0x03000918) == elapsed + 60);
            printf("snapshot timer before cheat: %u -> %u\n", elapsed, core->busRead32(core, 0x03000918));
        }
        struct mCheatSet* probe = device->createSet(device, NULL);
        mCheatAddSet(device, probe);
        assert(mCheatAddLine(probe, "08016568:46C0", 0));
        if (probe->refresh) probe->refresh(probe, device);
        printf("libretro probe: enabled=%u instruction=%04x\n", probe->enabled,
            core->busRead16(core, 0x08016568));
        for (unsigned frame = 0; frame < 5; frame++) core->runFrame(core);
        printf("libretro probe after frames: instruction=%04x\n", core->busRead16(core, 0x08016568));
        assert(core->busRead16(core, 0x08016568) == 0x46c0);
        unsigned elapsed = core->busRead32(core, 0x03000918);
        for (unsigned frame = 0; frame < 120; frame++) core->runFrame(core);
        if (getenv("CHEAT_RACE_STATE")) assert(core->busRead32(core, 0x03000918) == elapsed);
        mCheatDeviceClear(device);
        printf("libretro clear leaves ROM instruction=%04x\n", core->busRead16(core, 0x08016568));
        core->deinit(core);
        puts("PASS isolated libretro apply probe; clear does not certify ROM restoration");
        return 0;
    }
    struct VFile* file = VFileOpen("build/momotarou-zh-Hant.cht", O_RDONLY);
    assert(file && mCheatParseLibretroFile(device, file));
    file->close(file);
    assert(mCheatSetsSize(&device->cheats) == 6);
    if (getenv("CHEAT_WALK_STATE")) {
        walking_replay(core, device, getenv("CHEAT_WALK_STATE"));
        core->deinit(core);
        return 0;
    }
    const uint32_t addresses[] = {0x08041df2, 0x08041dfc, 0x0801aff8};
    for (unsigned index = 0; index < 3; index++) {
        struct mCheatSet* set = *mCheatSetsGetPointer(&device->cheats, index);
        unsigned original = index == 2 ? 0x3001 : 0xd900;
        assert(!set->enabled);
        assert(core->busRead16(core, addresses[index]) == original);
        set->enabled = true;
        mCheatRefresh(device, set);
        assert(core->busRead16(core, addresses[index]) == 0x46c0);
        set->enabled = false;
        mCheatRefresh(device, set);
        assert(core->busRead16(core, addresses[index]) == original);
    }
    puts("PASS libretro cheat parsing, disabled defaults, enable and exact instruction restoration");
    struct mDebugger debugger = {.type = DEBUGGER_CUSTOM, .init = debugger_noop,
        .deinit = debugger_noop, .entered = entered, .paused = debugger_noop, .update = debugger_noop};
    mDebuggerAttach(&debugger, core);
    for (unsigned index = 0; index < 2; index++) {
        struct mBreakpoint point = {.address = index ? 0x08041e2e : 0x08041de0,
            .segment = -1, .type = BREAKPOINT_HARDWARE};
        assert(debugger.platform->setBreakpoint(debugger.platform, &point) >= 0);
    }
    for (tested_mode = 0; tested_mode < 4; tested_mode++) {
        injected = verified = 0;
        core->reset(core);
        for (unsigned index = 0; index < 2; index++) {
            struct mCheatSet* set = *mCheatSetsGetPointer(&device->cheats, index);
            set->enabled = (tested_mode & (1u << index)) != 0;
            mCheatRefresh(device, set);
        }
        const unsigned steps[][2] = {{900, 0}, {2, 8}, {180, 0}, {2, 8}, {180, 0}, {2, 1}, {1500, 0}};
        debugger.state = DEBUGGER_RUNNING;
        for (unsigned step = 0; step < sizeof(steps) / sizeof(*steps) && !verified; step++) {
            core->setKeys(core, steps[step][1]);
            for (unsigned frame = 0; frame < steps[step][0] && !verified; frame++) mDebuggerRunFrame(&debugger);
        }
        assert(injected && verified);
        printf("PASS native battle update: mode=%u, all four allies, maximum HP/MP unchanged\n", tested_mode);
    }
    core->detachDebugger(core);
    struct mCheatSet* timer = *mCheatSetsGetPointer(&device->cheats, 2);
    for (unsigned enabled = 0; enabled < 2; enabled++) {
        timer->enabled = enabled;
        mCheatRefresh(device, timer);
        core->busWrite32(core, 0x03000210, 0x03000100);
        for (unsigned frame = 0; frame < 10; frame++) call_leaf(core, 0x0801afb8, 0);
        assert(core->busRead8(core, 0x03000213) == (enabled ? 3 : 13));
        core->busWrite32(core, 0x03000210, 0x03010000);
        call_leaf(core, 0x0801afb8, 0);
        assert(core->busRead8(core, 0x03000213) == 2);
        core->busWrite32(core, 0x03000210, 0x00000100);
        core->busWrite8(core, 0x0300021c, 1);
        core->busWrite16(core, 0x03001be2, 1);
        assert(call_leaf(core, 0x0801ad58, 0) == 0);
    }
    timer->enabled = false;
    mCheatRefresh(device, timer);
    puts("PASS native paper-fan timer: frozen only when enabled, countdown preserved, A accepted");
    struct mCheatSet* money = *mCheatSetsGetPointer(&device->cheats, 3);
    assert(!money->enabled);
    core->busWrite32(core, 0x020005b0, 123);
    call_leaf(core, 0x08001dd4, 1);
    assert(call_leaf(core, 0x0801465c, 0) == 124);
    money->enabled = true;
    mCheatRefresh(device, money);
    assert(call_leaf(core, 0x0801465c, 0) == 999999);
    money->enabled = false;
    mCheatRefresh(device, money);
    call_leaf(core, 0x08001dd4, (uint32_t)-100);
    assert(call_leaf(core, 0x0801465c, 0) == 999899);
    puts("PASS native wallet getter/setter: maximum balance, disabled spending resumes");
    struct mCheatSet* race = *mCheatSetsGetPointer(&device->cheats, 4);
    assert(!race->enabled);
    for (unsigned phase = 0; phase < 3; phase++) {
        race->enabled = phase == 1;
        mCheatRefresh(device, race);
        assert(core->busRead16(core, 0x08016568) == (race->enabled ? 0x46c0 : 0x3001));
        core->busWrite8(core, 0x030008fa, 0);
        core->busWrite32(core, 0x03000918, 123);
        core->busWrite32(core, 0x0300091c, 12600);
        for (unsigned frame = 0; frame < 10; frame++) race_timer_tick(core, false);
        assert(core->busRead32(core, 0x03000918) == (race->enabled ? 123u : 133u));
        assert(core->busRead32(core, 0x0300091c) == 12600);
        assert(core->busRead8(core, 0x030008fa) == 0);
        core->busWrite8(core, 0x030008fa, 4);
        core->busWrite32(core, 0x03000918, 123);
        race_timer_tick(core, true);
        assert(core->busRead32(core, 0x03000918) == 123);
        assert(core->busRead8(core, 0x030008fa) == 4);
    }
    puts("PASS native mountain-race timer: off/on/off, exact ROM restoration, benchmark and pause preserved");
    struct mCheatSet* encounters = *mCheatSetsGetPointer(&device->cheats, 5);
    assert(!encounters->enabled);
    for (unsigned phase = 0; phase < 3; phase++) {
        encounters->enabled = phase == 1;
        mCheatRefresh(device, encounters);
        assert(core->busRead16(core, 0x0800117a) == (encounters->enabled ? 0xe026u : 0xd026u));
        assert(core->busRead16(core, 0x08013bf4) == 0xd200u);
        for (unsigned active = 0; active < 2; active++) {
            for (unsigned moving = 0; moving < 2; moving++) {
                for (unsigned tile = 0; tile < 2; tile++) {
                    walking_encounters(core, encounters->enabled, active, moving, tile);
                }
            }
        }
        const unsigned games[] = {25, 27, 28, 29, 31, 32, 34, 35};
        for (unsigned game = 0; game < sizeof(games) / sizeof(games[0]); game++) {
            for (unsigned forced = 0; forced < 3; forced++) {
                encounter_gate(core, games[game], forced, false);
            }
        }
        field_dispatch(core, false, 0);
        field_dispatch(core, false, 0x400);
    }
    puts("PASS walking encounters: off/on/off, all movement states, NPC continuation retained, direct/item and forced entry points unchanged");
    core->deinit(core);
    return 0;
}