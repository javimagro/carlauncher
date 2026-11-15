/* SPDX-License-Identifier: MIT. Read-only scalar ABI, pinned to one revision.
 * Endpoint's source adapter and the real VI have DISTINCT UiConfig caches.
 * GetMargins(real VI) does not expose the source config's initial copy. */
#include "bridge-baseline.h"
#include <string.h>
static uintptr_t pointer(const void *object, size_t offset) {
    uintptr_t value;
    memcpy(&value, (const unsigned char *)object + offset, sizeof(value));
    return value;
}
static uint32_t word(const void *object, size_t offset) {
    uint32_t value;
    memcpy(&value, (const unsigned char *)object + offset, sizeof(value));
    return value;
}
int bm_selected_baseline(const void *wrapper, const void *callback,
                         uint32_t config, uintptr_t library_base,
                         struct bm_baseline *out) {
    if (!wrapper || !callback || !out ||
        pointer(wrapper, 0) != library_base + 0x3d81f8) return 0;
    const void *raw = (const void *)pointer(wrapper, 0x20);
    if (!raw) return 0;
    const void *vi = (const void *)pointer(raw, 0x70);
    if (!vi || pointer(vi, 0) != library_base + 0x3d89c8 ||
        word(vi, 0x50) != 0 || pointer(vi, 0x58) != (uintptr_t)callback ||
        pointer(vi, 0x60) != (uintptr_t)raw) return 0;
    const void *endpoint = (const void *)pointer(vi, 0x68);
    if (!endpoint || pointer(endpoint, 0) != library_base + 0x3e3538) return 0;
    const void *adapter = (const void *)pointer(endpoint, 0x58);
    if (!adapter || pointer(adapter, 0) != library_base + 0x3d8930 ||
        pointer(adapter, 0x48) != (uintptr_t)vi || word(adapter, 8) != config) return 0;
    uintptr_t first = pointer(endpoint, 0x60), last = pointer(endpoint, 0x68);
    if (!first || last < first || (last - first) % 16 ||
        (last - first) / 16 > 16 || config >= (last - first) / 16) return 0;
    const void *selected = (const void *)pointer((const void *)first, config * 16 + 8);
    if (!selected) return 0;
    uint32_t bits = word(selected, 0x10);
    struct bm_baseline observed;
    memset(&observed, 0, sizeof(observed));
    observed.config = config;
    observed.selected_mask = bits;
    observed.resolution = word(selected, 0x40);
    observed.margin_width = word(selected, 0x20);
    observed.margin_height = word(selected, 0x24);
    /* Profile proposals are defined only for a real selected 1920x1080 codec.
     * H/V presence bits and resolution bit are proven by constructor1334a0. */
    if ((bits & 0x206) != 0x206 || observed.resolution != 3 ||
        observed.margin_width >= 1920 || observed.margin_height >= 1080 ||
        (observed.margin_width & 1) || (observed.margin_height & 1)) return 0;
    const void *ui = (bits & 1) ? (const void *)pointer(selected, 0x18) : NULL;
    if (ui) {
        observed.ui_flags = word(ui, 0x10);
        if (observed.ui_flags & 8) observed.theme = word(ui, 0x30);
    }
    if (ui && (word(ui, 0x10) & 1)) {
        const void *margins = (const void *)pointer(ui, 0x18);
        if (!margins || (word(margins, 0x10) & 15) != 15) return 0;
        for (unsigned i = 0; i < 4; ++i) {
            observed.insets.present[i] = 1;
            observed.insets.value[i] = word(margins, 0x18 + i * 4);
        }
    } else {
        observed.legacy = 1;
        for (unsigned i = 0; i < 4; ++i) observed.insets.present[i] = 1;
        observed.insets.value[0] = observed.insets.value[1] = observed.margin_height / 2;
        observed.insets.value[2] = observed.insets.value[3] = observed.margin_width / 2;
    }
    if (!bm_valid(&observed.insets) ||
        observed.insets.value[0] + observed.insets.value[1] >= 1080 ||
        observed.insets.value[2] + observed.insets.value[3] >= 1920) return 0;
    *out = observed;
    return 1;
}
