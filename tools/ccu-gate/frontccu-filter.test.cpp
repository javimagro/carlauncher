#include "../../native/javi-ccu-gate/frontccu-filter.h"
#include <assert.h>
#include <string.h>

using namespace frontccu;

int main() {
    assert(!leaseFresh(-1));
    assert(leaseFresh(0));
    assert(leaseFresh(699999999));
    assert(!leaseFresh(700000000));
    assert(leaseMode(0, 1) == Mode::All);
    assert(leaseMode(2, 699999999) == Mode::AndroidAuto);
    assert(leaseMode(2, 700000000) == Mode::None);
    assert(leaseMode(2, -1) == Mode::None);
    assert(leaseMode(1, 0) == Mode::None && leaseMode(3, 0) == Mode::None);
    assert(payloadSize(buttons) == 8 && payloadSize(rotary) == 7 && payloadSize(0x8003) == 0);

    Filter filter;
    uint8_t idle[] = {5, 0xff, 0xfd, 0, 0, 0, 0};
    filter.apply(rotary, idle, Mode::None);
    const uint8_t directions[] = {1, 2, 4, 5, 7, 8, 10, 11};
    for (const auto direction : directions) {
        uint8_t active[] = {6, 0x00, 0x0a, 2, direction, 1, 1};
        filter.apply(rotary, active, Mode::All);
        const uint8_t expected[] = {6, 0xff, 0xfd, 0, 0, 0, 1};
        assert(memcmp(active, expected, sizeof active) == 0);
    }
    uint8_t released[] = {7, 0, 10, 0, 0, 0, 0};
    filter.apply(rotary, released, Mode::None);
    assert(released[1] == 0xff && released[2] == 0xfd);
    uint8_t next[] = {8, 0, 12, 1, 10, 0, 0};
    filter.apply(rotary, next, Mode::None);
    assert(next[1] == 0 && next[2] == 0 && next[3] == 1 && next[4] == 10);

    const uint8_t stock[] = {1, 2, 1, 1, 7, 1, 2, 1};
    uint8_t keys[8];
    memcpy(keys, stock, sizeof keys);
    filter.apply(buttons, keys, Mode::None);
    assert(memcmp(keys, stock, sizeof keys) == 0);
    filter.apply(buttons, keys, Mode::All);
    const uint8_t neutral[8] = {};
    assert(memcmp(keys, neutral, sizeof keys) == 0);

    // Only Hmi8's copy is transformed: AA receives rotary and central push,
    // all four short/long tilt states and physical navigation keys remain neutral.
    Filter aa;
    uint16_t counter = 65530;
    for (const auto direction : directions) {
        const uint16_t value = counter++ % 65535u;
        uint8_t rotaryAa[] = {9, static_cast<uint8_t>(value >> 8), static_cast<uint8_t>(value), 2, direction, 1, 1};
        aa.apply(rotary, rotaryAa, Mode::AndroidAuto);
        assert((rotaryAa[1] << 8 | rotaryAa[2]) == value);
        assert(rotaryAa[3] == 2 && rotaryAa[4] == 0 && rotaryAa[5] == 1 && rotaryAa[6] == 1);
        memcpy(keys, stock, sizeof keys);
        aa.apply(buttons, keys, Mode::AndroidAuto);
        assert(memcmp(keys, neutral, sizeof keys) == 0);
    }
    uint8_t invalid[] = {1, 0xff, 0xff, 1, 10, 0, 0};
    aa.apply(rotary, invalid, Mode::AndroidAuto);
    assert(invalid[1] == 0xff && invalid[2] == 0xff && invalid[3] == 1 && invalid[4] == 0);
    // All -> AA must not replay the rotations consumed by DriveHub.
    Filter switching;
    uint8_t original[] = {1, 0, 20, 0, 0, 0, 0};
    switching.apply(rotary, original, Mode::None);
    uint8_t frozen[] = {2, 0, 90, 1, 10, 1, 0};
    switching.apply(rotary, frozen, Mode::All);
    uint8_t resuming[] = {3, 0, 91, 1, 10, 1, 0};
    switching.apply(rotary, resuming, Mode::AndroidAuto);
    assert(resuming[2] == 20 && resuming[3] == 1 && resuming[4] == 0 && resuming[5] == 0);
    uint8_t rotated[] = {4, 0, 92, 0, 4, 1, 0};
    switching.apply(rotary, rotated, Mode::AndroidAuto);
    assert(rotated[2] == 21 && rotated[4] == 0 && rotated[5] == 1);
    uint8_t expired[] = {5, 0, 93, 1, 4, 1, 0};
    switching.apply(rotary, expired, Mode::None);
    assert(expired[2] == 22 && expired[3] == 1 && expired[4] == 4 && expired[5] == 1);
}
