#include "../../native/javi-ccu-gate/frontccu-filter.h"
#include <assert.h>
#include <string.h>

using namespace frontccu;

int main() {
    assert(!leaseFresh(-1));
    assert(leaseFresh(0));
    assert(leaseFresh(699999999));
    assert(!leaseFresh(700000000));
    assert(payloadSize(buttons) == 8 && payloadSize(rotary) == 7 && payloadSize(0x8003) == 0);

    Filter filter;
    uint8_t idle[] = {5, 0xff, 0xfd, 0, 0, 0, 0};
    filter.apply(rotary, idle, false);
    const uint8_t directions[] = {1, 2, 4, 5, 7, 8, 10, 11};
    for (const auto direction : directions) {
        uint8_t active[] = {6, 0x00, 0x0a, 2, direction, 1, 1};
        filter.apply(rotary, active, true);
        const uint8_t expected[] = {6, 0xff, 0xfd, 0, 0, 0, 1};
        assert(memcmp(active, expected, sizeof active) == 0);
    }
    uint8_t released[] = {7, 0, 10, 0, 0, 0, 0};
    filter.apply(rotary, released, false);
    assert(released[1] == 0xff && released[2] == 0xfd);
    uint8_t next[] = {8, 0, 12, 1, 10, 0, 0};
    filter.apply(rotary, next, false);
    assert(next[1] == 0 && next[2] == 0 && next[3] == 1 && next[4] == 10);

    const uint8_t stock[] = {1, 2, 1, 1, 7, 1, 2, 1};
    uint8_t keys[8];
    memcpy(keys, stock, sizeof keys);
    filter.apply(buttons, keys, false);
    assert(memcmp(keys, stock, sizeof keys) == 0);
    filter.apply(buttons, keys, true);
    const uint8_t neutral[8] = {};
    assert(memcmp(keys, neutral, sizeof keys) == 0);
}
