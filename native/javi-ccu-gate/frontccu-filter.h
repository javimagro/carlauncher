#ifndef JAVI_FRONTCCU_FILTER_H
#define JAVI_FRONTCCU_FILTER_H

#include <stddef.h>
#include <stdint.h>

namespace frontccu {

constexpr uint16_t service = 0xb508;
constexpr uint16_t instance = 1;
constexpr uint16_t buttons = 0x8001;
constexpr uint16_t rotary = 0x8002;

inline size_t payloadSize(uint16_t event) {
    return event == buttons ? 8 : event == rotary ? 7 : 0;
}

inline bool leaseFresh(int64_t ageNs) {
    return ageNs >= 0 && ageNs < 700000000;
}

struct Filter {
    uint16_t position = 0;
    uint16_t offset = 0;
    bool havePosition = false;
    bool frozen = false;

    void apply(uint16_t event, uint8_t *data, bool capture) {
        if (event == buttons) {
            if (capture) {
                for (size_t i = 0; i < payloadSize(buttons); ++i) data[i] = 0;
            }
            return;
        }

        const auto raw = static_cast<uint16_t>(data[1] << 8 | data[2]);
        if (capture) {
            frozen = true;
            data[3] = 0;
            data[4] = 0;
            data[5] = 0;
            if (!havePosition && raw != 0xffff) {
                position = raw;
                havePosition = true;
            }
        } else if (raw != 0xffff) {
            // 0xffff is reserved. Keep valid positions in the 0..65534 range.
            if (frozen && havePosition) {
                offset = (raw + 65535u - position) % 65535u;
                data[5] = 0;
            }
            frozen = false;
            position = (raw + 65535u - offset) % 65535u;
            havePosition = true;
        } else {
            return;
        }
        if (havePosition) {
            data[1] = static_cast<uint8_t>(position >> 8);
            data[2] = static_cast<uint8_t>(position);
        }
    }
};

} // namespace frontccu

#endif
