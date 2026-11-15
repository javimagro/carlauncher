/* SPDX-License-Identifier: MIT. MAIN format acquisition and restoration. */
#ifndef BMW_MAIN_BRIDGE_STATE_H
#define BMW_MAIN_BRIDGE_STATE_H
#include <stdint.h>

/* Scalar copy only. No SDK object, protobuf or telephone identifier. */
struct bm_insets { uint32_t present[4], value[4]; };
enum bm_phase { BM_OFF, BM_WAIT, BM_READY, BM_APPLY, BM_ACTIVE,
                BM_RESTORE, BM_DONE, BM_BLOCKED };
struct bm_state {
    uint64_t epoch, generation, lease_until, ack_until, request_seq, set_started_ns;
    uint64_t ack_count, ignored, changes, restores, faults;
    uint32_t config;
    enum bm_phase phase;
    int accepted, baseline_valid, used, dirty, stop, uncertain;
    int call_started, call_returned, ack_seen;
    struct bm_insets baseline, requested;
};
/* All calls are serialized by the adapter's short state mutex. Time is ms. */
void bm_init(struct bm_state *s);
uint64_t bm_begin(struct bm_state *s);
void bm_begin_result(struct bm_state *s, uint64_t epoch, int32_t result);
void bm_end(struct bm_state *s);
void bm_config(struct bm_state *s, uint32_t display, uint32_t config,
               int32_t result, const struct bm_insets *baseline);
int bm_request(struct bm_state *s, uint64_t epoch,
               const struct bm_insets *target, uint64_t now);
int bm_renew(struct bm_state *s, uint64_t epoch, uint64_t now);
/* Rearm only the exact clean restored observation, without changing baseline.
 * Control adapter additionally requires a new connection with no ownership. */
int bm_rearm(struct bm_state *s, uint64_t epoch, uint64_t generation,
             uint64_t update_seq);
void bm_stop(struct bm_state *s);
void bm_tick(struct bm_state *s, uint64_t now);
int bm_action(struct bm_state *s, uint64_t *epoch, struct bm_insets *out,
              uint64_t started_ns);
void bm_call_result(struct bm_state *s, uint64_t epoch, int32_t result,
                    uint64_t now);
void bm_ack(struct bm_state *s, uint32_t display, int has,
            const struct bm_insets *value, uint64_t now);
int bm_valid(const struct bm_insets *m);
int bm_equal(const struct bm_insets *a, const struct bm_insets *b);
const char *bm_name(enum bm_phase phase);
#endif
