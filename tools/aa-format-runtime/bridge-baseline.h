/* SPDX-License-Identifier: MIT */
#ifndef BMW_MAIN_BRIDGE_BASELINE_H
#define BMW_MAIN_BRIDGE_BASELINE_H
#include "bridge-state.h"
#include <stdint.h>
struct bm_baseline {
    struct bm_insets insets;
    uint32_t config, resolution, margin_width, margin_height;
    uint32_t selected_mask, ui_flags, theme;
    int legacy;
};
/* Only on the native OnVideoConfig thread, for pinned firmware and a retained
 * MAIN wrapper. No general memory reader and no worker use. */
int bm_selected_baseline(const void *wrapper, const void *callback,
                         uint32_t config, uintptr_t library_base,
                         struct bm_baseline *out);
#endif
