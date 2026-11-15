/* SPDX-License-Identifier: MIT. Linux adapter for the pinned MAIN profile. */
#ifndef BMW_MAIN_BRIDGE_PRIVATE_H
#define BMW_MAIN_BRIDGE_PRIVATE_H
#define _GNU_SOURCE
#include "bridge-state.h"
#include "bridge-baseline.h"
#include "bridge-profile.h"
#include "bridge-diag.h"
#include "bridge-abi.h"
#include <pthread.h>
#include <stddef.h>
#include <stdint.h>
#include <stdatomic.h>
#ifndef BM_ENABLE_WRITES
#define BM_ENABLE_WRITES 0 /* Writes require an explicit build option. */
#endif
typedef int32_t (*bm_callbacks_fn)(void *, void *, void *, void *);
typedef int32_t (*bm_begin_fn)(void *);
typedef int32_t (*bm_end_fn)(void *, uint32_t);
typedef int32_t (*bm_config_fn)(void *, uint32_t, uint32_t);
typedef int32_t (*bm_ui_fn)(void *, uint32_t, int32_t,
    const struct bmw_aa_insets *, int32_t, const struct bmw_aa_insets *,
    int32_t, const struct bmw_aa_insets *, int32_t, uint32_t);
struct bm_bridge {
    pthread_mutex_t state_lock, operation_lock, install_lock;
    struct bm_state state;
    struct bm_baseline observed;
    uint32_t current_theme;
    int theme_present;
    uintptr_t aa_base, app_base;
    uint64_t starttime;
    void *owner, *core, *video;
    struct bmw_aa_display *display;
    void *primary[57], *core_table[14], *video_table[8];
    bmw_aa_get_display_fn get_display;
    bm_callbacks_fn set_callbacks;
    bm_begin_fn begin;
    bm_end_fn end;
    bm_config_fn config;
    bm_ui_fn ui;
    bmw_aa_set_margins_fn set;
    int callbacks_ready, worker_started;
    _Atomic int disabled;
};
extern struct bm_bridge bm;
uint64_t bm_clock(void);
void *bm_server(void *unused);
void bm_perform(void);
int bm_guard(void *factory, uintptr_t *app, uintptr_t *aa);
void bm_copy_in(struct bm_insets *out, const struct bmw_aa_insets *in);
void bm_copy_out(struct bmw_aa_insets *out, const struct bm_insets *in);
#endif
