// Compile-time serialization regression; no BMW runtime or network execution.
#include "map-rendering-settings.h"
constexpr bool renderingWire() {
    constexpr auto init = map_probe::renderingRequest(0x12345678, map_probe::RenderingMode::Initialization);
    constexpr auto visible = map_probe::renderingRequest(0x12345678, map_probe::RenderingMode::Visible);
    constexpr uint8_t expected[] = {
        0,0,0,0, 0x12,0x34,0x56,0x78, 0,0,0,0x42, 0,0,0,0
    };
    if (sizeof(init.bytes) != sizeof(expected) || sizeof(visible.bytes) != sizeof(expected)) return false;
    for (unsigned i = 0; i < sizeof(expected); ++i) {
        if (init.bytes[i] != expected[i]) return false;
        if (visible.bytes[i] != (i == 11 ? 0x43 : expected[i])) return false;
    }
    return true;
}
static_assert(renderingWire(), "Initialization must preserve the own handle, session zero and empty scene vector");

constexpr bool notificationWire() {
    uint8_t event[] = {0x12,0x34,0x56,0x78, 0,0,0,0x42, 0};
    if (map_probe::renderingEventMode(event, 8, 0x12345678) != 0x42) return false;
    // A shared event must never turn a cockpit/other view into our confirmation.
    if (map_probe::renderingEventMode(event, 8, 0x12345679) != 0) return false;
    if (map_probe::renderingEventMode(event, 8, 0) != 0) return false;
    if (map_probe::renderingEventMode(event, 8, 0xffffffffU) != 0) return false;
    if (map_probe::renderingEventMode(nullptr, 8, 0x12345678) != 0) return false;
    for (unsigned length = 0; length < 8; ++length)
        if (map_probe::renderingEventMode(event, length, 0x12345678) != 0) return false;
    if (map_probe::renderingEventMode(event, 9, 0x12345678) != 0) return false;
    for (unsigned mode = 0; mode < 256; ++mode) {
        event[7] = uint8_t(mode);
        const auto expected = mode >= 0x42 && mode <= 0x4a ? mode : 0;
        if (map_probe::renderingEventMode(event, 8, 0x12345678) != expected) return false;
    }
    // Wrong enum byte order must not be interpreted as INITIALIZATION.
    event[4] = 0x42; event[7] = 0;
    return map_probe::renderingEventMode(event, 8, 0x12345678) == 0;
}
static_assert(notificationWire(), "Only an exact, valid own-view notification can confirm a rendering mode");
