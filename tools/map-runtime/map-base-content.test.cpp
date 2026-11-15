// Compile-time wire regression: tested without executing any BMW code/network.
#include "map-base-content.h"
constexpr bool expectedWire() {
    constexpr auto request = map_probe::baseContentRequest(0x12345678);
    constexpr uint8_t expected[] = {
        0,0,0,0, 0x12,0x34,0x56,0x78, 0,0,0,5, 0,0,0,15, 1
    };
    if (sizeof(request.bytes) != sizeof(expected)) return false;
    for (unsigned i = 0; i < sizeof(expected); ++i)
        if (request.bytes[i] != expected[i]) return false;
    return true;
}
static_assert(expectedWire(), "FA95:20 must encode a 5-byte map entry, not an entry count or padded struct");
constexpr auto another = map_probe::baseContentRequest(0x80fedc01);
static_assert(another.bytes[4] == 0x80 && another.bytes[5] == 0xfe &&
    another.bytes[6] == 0xdc && another.bytes[7] == 1,
    "The newly returned handle must be preserved in big-endian order");
