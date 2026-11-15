// MGU21 21.47 only. See MAPA-ENSAYO-LOCAL.md for the proxy/consumer evidence.
#ifndef BMWLAUNCHER_MAP_BASE_CONTENT_H
#define BMWLAUNCHER_MAP_BASE_CONTENT_H
#include <cstdint>

namespace map_probe {
struct BaseContentRequest { uint8_t bytes[17]; };
// FA95:20: session UInt32, OWN handle UInt32, dictionary byte length UInt32,
// MapObject UInt32, Boolean UInt8. CommonAPI does not pad dictionary entries.
// Object 15 expands to the base-map feature groups; it is not a scene/route ID.
constexpr BaseContentRequest baseContentRequest(uint32_t handle) {
    return {{0, 0, 0, 0,
        uint8_t(handle >> 24), uint8_t(handle >> 16), uint8_t(handle >> 8), uint8_t(handle),
        0, 0, 0, 5, 0, 0, 0, 15, 1}};
}
}
#endif
