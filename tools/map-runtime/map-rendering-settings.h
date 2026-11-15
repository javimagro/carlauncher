// MGU21 21.47 wire format. Evidence: MAPA-ENSAYO-LOCAL.md.
#ifndef BMWLAUNCHER_MAP_RENDERING_SETTINGS_H
#define BMWLAUNCHER_MAP_RENDERING_SETTINGS_H
#include <cstddef>
#include <cstdint>

namespace map_probe {
enum class RenderingMode : uint32_t { Initialization = 0x42, Visible = 0x43 };
struct RenderingRequest { uint8_t bytes[16]; };
// FA94:3b: session=0, newly-created handle, enum, EMPTY UInt64 vector.
// No shared scene ID. An RPC ACK does not confirm the engine's rendering mode.
constexpr RenderingRequest renderingRequest(uint32_t handle, RenderingMode mode) {
    return {{0, 0, 0, 0,
        uint8_t(handle >> 24), uint8_t(handle >> 16), uint8_t(handle >> 8), uint8_t(handle),
        0, 0, 0, uint8_t(mode), 0, 0, 0, 0}};
}
// FA94:8002, group 2: OWN handle UInt32 + rendering enum Int32, big-endian.
// Zero means no admissible observation, not a BMW rendering mode.
constexpr uint32_t renderingEventMode(const uint8_t* data, size_t length, uint32_t ownHandle) {
    if (!data || length != 8 || !ownHandle || ownHandle == 0xffffffffU) return 0;
    const uint32_t handle = uint32_t(data[0]) << 24 | uint32_t(data[1]) << 16 |
        uint32_t(data[2]) << 8 | data[3];
    const uint32_t mode = uint32_t(data[4]) << 24 | uint32_t(data[5]) << 16 |
        uint32_t(data[6]) << 8 | data[7];
    return handle == ownHandle && mode >= 0x42 && mode <= 0x4a ? mode : 0;
}
}
#endif
