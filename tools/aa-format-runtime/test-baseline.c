/* SPDX-License-Identifier: MIT. Fake graph; no firmware is executed. */
#include "bridge-baseline.h"
#include <stdio.h>
#include <string.h>
static unsigned checks, failures;
#define CHECK(x) do { ++checks; if (!(x)) { ++failures; \
    fprintf(stderr, "baseline line %d: %s\n", __LINE__, #x); } } while (0)
static void put(void *object, size_t offset, uintptr_t value) {
    memcpy((unsigned char *)object + offset, &value, sizeof(value));
}
static void word(void *object, size_t offset, uint32_t value) {
    memcpy((unsigned char *)object + offset, &value, sizeof(value));
}
int baseline_tests(void) {
    uint64_t wrapper[6] = {0}, raw[16] = {0}, vi[24] = {0}, endpoint[20] = {0};
    uint64_t adapter[10] = {0}, entries[4] = {0}, selected[10] = {0};
    uint64_t ui[7] = {0}, insets[5] = {0}, wrong[10] = {0};
    const uintptr_t base = 0x10000000;
    const void *callback = (const void *)&checks;
    put(wrapper, 0, base + 0x3d81f8); put(wrapper, 0x20, (uintptr_t)raw);
    put(raw, 0x70, (uintptr_t)vi);
    put(vi, 0, base + 0x3d89c8); word(vi, 0x50, 0);
    put(vi, 0x58, (uintptr_t)callback); put(vi, 0x60, (uintptr_t)raw);
    put(vi, 0x68, (uintptr_t)endpoint);
    put(endpoint, 0, base + 0x3e3538); put(endpoint, 0x58, (uintptr_t)adapter);
    put(endpoint, 0x60, (uintptr_t)entries); put(endpoint, 0x68, (uintptr_t)(entries + 4));
    put(adapter, 0, base + 0x3d8930); word(adapter, 8, 1);
    put(adapter, 0x48, (uintptr_t)vi);
    entries[1] = (uintptr_t)wrong; entries[3] = (uintptr_t)selected;
    word(selected, 0x10, 0x7df); word(selected, 0x40, 3);
    word(selected, 0x20, 0); word(selected, 0x24, 496);
    put(selected, 0x18, (uintptr_t)ui); word(ui, 0x10, 9);
    put(ui, 0x18, (uintptr_t)insets); word(insets, 0x10, 15);
    word(insets, 0x18, 248); word(insets, 0x1c, 248);
    struct bm_baseline result;
    CHECK(bm_selected_baseline(wrapper, callback, 1, base, &result));
    CHECK(result.config == 1 && result.resolution == 3 && !result.legacy);
    CHECK(result.insets.value[0] == 248 && result.insets.value[1] == 248 &&
          !result.insets.value[2] && !result.insets.value[3]);
    /* The real VI's empty UiConfig is deliberately not the source baseline. */
    CHECK(!vi[4] && !vi[5]);
    word(selected, 0x24, 400);
    CHECK(bm_selected_baseline(wrapper, callback, 1, base, &result));
    CHECK(result.insets.value[0] == 248); /* Explicit margins override legacy. */
    word(ui, 0x10, 8);
    CHECK(bm_selected_baseline(wrapper, callback, 1, base, &result));
    CHECK(result.legacy && result.insets.value[0] == 200 && result.insets.value[1] == 200);
    word(selected, 0x20, 48);
    CHECK(bm_selected_baseline(wrapper, callback, 1, base, &result));
    CHECK(result.insets.value[2] == 24 && result.insets.value[3] == 24);
    word(ui, 0x10, 9); word(selected, 0x10, 0x7de);
    CHECK(bm_selected_baseline(wrapper, callback, 1, base, &result));
    CHECK(result.legacy && result.insets.value[0] == 200); /* Pointer alone is not presence. */
    word(ui, 0x10, 8); word(selected, 0x10, 0x7df);
    word(selected, 0x24, 401);
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base, &result));
    word(selected, 0x24, 400); word(selected, 0x40, 2);
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base, &result));
    word(selected, 0x40, 3); word(vi, 0x50, 1);
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base, &result));
    word(vi, 0x50, 0);
    CHECK(!bm_selected_baseline(wrapper, wrong, 1, base, &result));
    CHECK(!bm_selected_baseline(wrapper, callback, 0, base, &result));
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base + 8, &result));
    put(endpoint, 0x68, (uintptr_t)entries + 17);
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base, &result));
    put(endpoint, 0x68, (uintptr_t)(entries + 4)); word(ui, 0x10, 9);
    word(insets, 0x10, 7);
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base, &result));
    word(insets, 0x10, 15); word(insets, 0x18, 1080);
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base, &result));
    word(insets, 0x18, 248); word(selected, 0x10, 0);
    CHECK(!bm_selected_baseline(wrapper, callback, 1, base, &result));
    printf("Selected baseline: %u checks, %u failures\n", checks, failures);
    return failures != 0;
}
