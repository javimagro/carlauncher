/* SPDX-License-Identifier: MIT. Pinned MAIN format adapter.
 * No code patching, ptrace, memory-file access or IC setter. */
#include "bridge-private.h"
#include <dlfcn.h>
#include <errno.h>
#include <string.h>
#include <time.h>

struct bm_bridge bm = {
    .state_lock = PTHREAD_MUTEX_INITIALIZER,
    .operation_lock = PTHREAD_MUTEX_INITIALIZER,
    .install_lock = PTHREAD_MUTEX_INITIALIZER
};
static pthread_once_t factory_once = PTHREAD_ONCE_INIT;
static bmw_aa_create_fn original_factory;
static void resolve_factory(void) {
    original_factory = (bmw_aa_create_fn)dlsym(RTLD_NEXT, "CinemoCreateAndroidAuto");
}
static uint64_t clock_ns(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) return 0;
    return (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
}
uint64_t bm_clock(void) {
    uint64_t ns = clock_ns();
    return ns ? ns / 1000000 : UINT64_MAX / 2;
}
void bm_copy_in(struct bm_insets *out, const struct bmw_aa_insets *in) {
    out->present[0] = in->top.present; out->value[0] = in->top.value;
    out->present[1] = in->bottom.present; out->value[1] = in->bottom.value;
    out->present[2] = in->left.present; out->value[2] = in->left.value;
    out->present[3] = in->right.present; out->value[3] = in->right.value;
}
void bm_copy_out(struct bmw_aa_insets *out, const struct bm_insets *in) {
    out->top.present = in->present[0]; out->top.value = in->value[0];
    out->bottom.present = in->present[1]; out->bottom.value = in->value[1];
    out->left.present = in->present[2]; out->left.value = in->value[2];
    out->right.present = in->present[3]; out->right.value = in->value[3];
}
static void start_worker_locked(void) {
    if (bm.worker_started || bm.disabled || !bm.callbacks_ready || !bm.display) return;
    pthread_attr_t attr;
    pthread_t thread;
    if (pthread_attr_init(&attr)) { bm.disabled = 1; bm_diag(BM_D_WORKER_FAILED); return; }
    int failed = pthread_attr_setstacksize(&attr, 512 * 1024);
    if (!failed) failed = pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
    if (!failed) failed = pthread_create(&thread, &attr, bm_server, NULL);
    pthread_attr_destroy(&attr);
    if (failed) { bm.disabled = 1; bm_diag(BM_D_WORKER_FAILED); }
    else { bm.worker_started = 1; bm_diag(BM_D_WORKER_READY); }
}
static int32_t observed_begin(void *self) {
    int saved = errno;
    pthread_mutex_lock(&bm.operation_lock);
    pthread_mutex_lock(&bm.state_lock);
    uint64_t epoch = bm_begin(&bm.state);
    memset(&bm.observed, 0, sizeof(bm.observed));
    bm.theme_present = 0;
    pthread_mutex_unlock(&bm.state_lock);
    pthread_mutex_unlock(&bm.operation_lock);
    errno = saved;
    int32_t result = bm.begin(self);
    saved = errno;
    bm_diag(result ? BM_D_SESSION_REJECTED : BM_D_SESSION_ACCEPTED);
    pthread_mutex_lock(&bm.state_lock);
    bm_begin_result(&bm.state, epoch, result);
    pthread_mutex_unlock(&bm.state_lock);
    errno = saved;
    return result;
}
static int32_t observed_end(void *self, uint32_t reason) {
    int saved = errno;
    /* Native Reader/Writer have already been drained. Prevent an old setter
     * from surviving End and reaching the next VideoInterface. */
    pthread_mutex_lock(&bm.operation_lock);
    pthread_mutex_lock(&bm.state_lock);
    bm_end(&bm.state);
    bm_diag(BM_D_SESSION_ENDED);
    memset(&bm.observed, 0, sizeof(bm.observed));
    bm.theme_present = 0;
    pthread_mutex_unlock(&bm.state_lock);
    pthread_mutex_unlock(&bm.operation_lock);
    errno = saved;
    return bm.end(self, reason);
}
static int32_t observed_config(void *self, uint32_t display, uint32_t config) {
    int saved = errno, read_result = 13, read_baseline = 0;
    uint64_t epoch = 0;
    struct bm_insets value;
    struct bm_baseline observed;
    memset(&value, 0, sizeof(value));
    if (!display) bm_diag(BM_D_CONFIG_SEEN);
    pthread_mutex_lock(&bm.state_lock);
    epoch = bm.state.epoch;
    read_baseline = !display && bm.display && bm.state.phase == BM_WAIT &&
                    !bm.state.baseline_valid && !bm.disabled;
    pthread_mutex_unlock(&bm.state_lock);
    /* Only on the source-config callback thread. The endpoint vector is
     * constructed before Reader startup and released after Reader is drained.
     * Never read it from the socket worker or UiConfig update callback. */
    if (read_baseline) {
        read_result = bm_selected_baseline(bm.display, self, config, bm.aa_base,
                                           &observed) ? 0 : 118;
        if (!read_result) value = observed.insets;
        bm_diag(read_result ? BM_D_BASELINE_REJECTED : BM_D_BASELINE_READY);
    }
    errno = saved;
    int32_t result = bm.config(self, display, config);
    saved = errno;
    pthread_mutex_lock(&bm.state_lock);
    if (bm.state.epoch == epoch) {
        bm_config(&bm.state, display, config, result ? result : read_result, &value);
        if (read_baseline && !read_result && !result) {
            bm.observed = observed;
            bm.current_theme = observed.theme;
            bm.theme_present = (observed.ui_flags & 8) != 0;
        }
    }
    pthread_mutex_unlock(&bm.state_lock);
    errno = saved;
    return result;
}
static int32_t observed_ui(void *self, uint32_t display, int32_t has,
    const struct bmw_aa_insets *insets, int32_t current_has,
    const struct bmw_aa_insets *current, int32_t stable_has,
    const struct bmw_aa_insets *stable, int32_t theme_has, uint32_t theme) {
    int saved = errno;
    struct bm_insets value;
    memset(&value, 0, sizeof(value));
    if (!display && has && insets) bm_copy_in(&value, insets);
    pthread_mutex_lock(&bm.state_lock);
    if (!display && theme_has) { bm.current_theme = theme; bm.theme_present = 1; }
    bm_ack(&bm.state, display, has && insets, &value, bm_clock());
    pthread_mutex_unlock(&bm.state_lock);
    errno = saved;
    return bm.ui(self, display, has, insets, current_has, current,
                 stable_has, stable, theme_has, theme);
}
static int32_t observed_callbacks(void *self, void *audio, void *core, void *video) {
    int saved = errno;
    void **core_original = NULL, **video_original = NULL;
    int install = 0;
    pthread_mutex_lock(&bm.install_lock);
    /* This exact constructor call occurs before SetCallbacks publishes raw
     * pointers. Never exchange a vptr on an already active callback object. */
    if (!bm.core && !bm.disabled && self == bm.owner && audio && core && video &&
        (uintptr_t)__builtin_return_address(0) == bm.app_base + 0x354c27 &&
        (uintptr_t)audio + 8 == (uintptr_t)core &&
        (uintptr_t)core + 0x18 == (uintptr_t)video &&
        (uintptr_t)*(void ***)core == bm.app_base + 0xa8fdd8 &&
        (uintptr_t)*(void ***)video == bm.app_base + 0xa8feb0) {
        core_original = *(void ***)core;
        video_original = *(void ***)video;
        memcpy(bm.core_table, core_original - 2, sizeof(bm.core_table));
        memcpy(bm.video_table, video_original - 2, sizeof(bm.video_table));
        bm.begin = (bm_begin_fn)core_original[3];
        bm.end = (bm_end_fn)core_original[5];
        bm.config = (bm_config_fn)video_original[2];
        bm.ui = (bm_ui_fn)video_original[5];
        bm.core_table[2 + 3] = (void *)observed_begin;
        bm.core_table[2 + 5] = (void *)observed_end;
        bm.video_table[2 + 2] = (void *)observed_config;
        bm.video_table[2 + 5] = (void *)observed_ui;
        bm.core = core; bm.video = video;
        *(void ***)core = bm.core_table + 2;
        *(void ***)video = bm.video_table + 2;
        install = 1;
    }
    if (!install && !bm.core) bm_diag(BM_D_CALLBACK_UNSUPPORTED);
    pthread_mutex_unlock(&bm.install_lock);
    errno = saved;
    int32_t result = bm.set_callbacks(self, audio, core, video);
    saved = errno;
    if (install) {
        pthread_mutex_lock(&bm.install_lock);
        if (result) {
            /* Failure at this constructor point means pointers were not stored. */
            *(void ***)core = core_original;
            *(void ***)video = video_original;
            bm.disabled = 1;
            bm_diag(BM_D_CALLBACK_RESULT);
        } else {
            bm.callbacks_ready = 1;
            bm_diag(BM_D_CALLBACK_READY);
            start_worker_locked();
        }
        pthread_mutex_unlock(&bm.install_lock);
    }
    errno = saved;
    return result;
}
static int32_t observed_display(struct bmw_aa_interface *self,
                                struct bmw_aa_display **out, uint32_t index) {
    int32_t result = bm.get_display(self, out, index);
    int saved = errno;
    if (!result && !index && out && *out && self == bm.owner) {
        pthread_mutex_lock(&bm.install_lock);
        void **table = *(void ***)*out;
        if (!bm.display && !bm.disabled &&
            (uintptr_t)table == bm.aa_base + BMW_AA_DISPLAY_VPTR_RVA &&
            (uintptr_t)table[BMW_AA_ADDREF_SLOT] == bm.aa_base + BMW_AA_DISPLAY_ADDREF_RVA &&
            (uintptr_t)table[BMW_AA_GET_MARGINS_SLOT] == bm.aa_base + BMW_AA_GET_MARGINS_RVA &&
            (uintptr_t)table[BMW_AA_SET_MARGINS_SLOT] == bm.aa_base + BMW_AA_SET_MARGINS_RVA) {
            ((bmw_aa_ref_fn)table[BMW_AA_ADDREF_SLOT])(*out);
            pthread_mutex_lock(&bm.state_lock);
            bm.set = (bmw_aa_set_margins_fn)table[BMW_AA_SET_MARGINS_SLOT];
            bm.display = *out;
            bm_diag(BM_D_MAIN_READY);
            pthread_mutex_unlock(&bm.state_lock);
            /* One retained wrapper, bounded until process exit. Do not keep
             * AndroidAuto itself alive, nor dereference its owner in worker. */
            start_worker_locked();
        } else if (!bm.display) bm_diag(BM_D_MAIN_UNSUPPORTED);
        pthread_mutex_unlock(&bm.install_lock);
    }
    errno = saved;
    return result;
}
void bm_perform(void) {
    struct bm_insets value;
    struct bmw_aa_insets native;
    uint64_t epoch;
    pthread_mutex_lock(&bm.operation_lock);
    pthread_mutex_lock(&bm.state_lock);
    bm_tick(&bm.state, bm_clock());
    int act = bm_action(&bm.state, &epoch, &value, clock_ns());
    pthread_mutex_unlock(&bm.state_lock);
    if (act) {
        bm_copy_out(&native, &value);
        /* State mutex is not held: a synchronous ACK must never deadlock. */
        int32_t result = bm.set(bm.display, &native);
        pthread_mutex_lock(&bm.state_lock);
        bm_call_result(&bm.state, epoch, result, bm_clock());
        pthread_mutex_unlock(&bm.state_lock);
    }
    pthread_mutex_unlock(&bm.operation_lock);
}
__attribute__((visibility("default")))
int32_t CinemoCreateAndroidAuto(struct bmw_aa_interface **out) {
    int saved = errno;
    bm_diag(BM_D_FACTORY_SEEN);
    pthread_once(&factory_once, resolve_factory);
    errno = saved;
    if (!original_factory) return BMW_AA_NOT_READY_OBSERVED;
    int32_t result = original_factory(out);
    saved = errno;
    if (result) bm_diag(BM_D_FACTORY_RESULT);
    if (!result && out && *out) {
        pthread_mutex_lock(&bm.install_lock);
        if (!bm.owner && !bm.disabled) {
            uintptr_t app, aa;
            if (!bm_guard((void *)original_factory, &app, &aa)) bm.disabled = 1;
            else if ((uintptr_t)*(void ***)*out == aa + BMW_AA_PRIMARY_VPTR_RVA) {
                void **table = *(void ***)*out;
                bm.aa_base = aa; bm.app_base = app;
                bm.get_display = (bmw_aa_get_display_fn)table[BMW_AA_GET_DISPLAY_SLOT];
                bm.set_callbacks = (bm_callbacks_fn)table[6];
                memcpy(bm.primary, table - 2, sizeof(bm.primary));
                bm.primary[2 + BMW_AA_GET_DISPLAY_SLOT] = (void *)observed_display;
                bm.primary[2 + 6] = (void *)observed_callbacks;
                bm.owner = *out;
                *(void ***)*out = bm.primary + 2;
                bm_diag(BM_D_OWNER_READY);
            } else { bm.disabled = 1; bm_diag(BM_D_OWNER_VTABLE); }
        }
        pthread_mutex_unlock(&bm.install_lock);
    }
    errno = saved;
    return result;
}
