/* SPDX-License-Identifier: MIT */
#include "bridge-state.h"
#include <string.h>

enum { LEASE_MS = 1000, ACK_MS = 2000 };
int bm_valid(const struct bm_insets *m) {
    if (!m) return 0;
    for (unsigned i = 0; i < 4; ++i)
        if (m->present[i] != 1 || m->value[i] > 4096) return 0;
    return 1;
}
int bm_equal(const struct bm_insets *a, const struct bm_insets *b) {
    return memcmp(a, b, sizeof(*a)) == 0;
}
void bm_init(struct bm_state *s) { memset(s, 0, sizeof(*s)); }
uint64_t bm_begin(struct bm_state *s) {
    uint64_t epoch = s->epoch + 1;
    bm_init(s);
    s->epoch = epoch;
    s->generation = 1;
    s->phase = BM_WAIT;
    return epoch;
}
void bm_begin_result(struct bm_state *s, uint64_t epoch, int32_t result) {
    if (s->epoch != epoch || s->phase != BM_WAIT) return;
    s->accepted = result == 0;
    if (result) s->phase = BM_BLOCKED;
    else if (s->baseline_valid) s->phase = BM_READY;
}
void bm_end(struct bm_state *s) {
    ++s->epoch;
    s->phase = BM_OFF;
    s->accepted = s->baseline_valid = 0;
    s->call_started = s->call_returned = s->ack_seen = 0;
    /* A disconnected phone is not reported as ACK-restored. */
    s->dirty = 0;
}
void bm_config(struct bm_state *s, uint32_t display, uint32_t config,
               int32_t result, const struct bm_insets *baseline) {
    if (display || s->phase == BM_OFF || s->phase == BM_BLOCKED) return;
    if (s->baseline_valid) {
        if (s->config == config) return; /* Never replace original with ours. */
        s->phase = BM_BLOCKED;
        s->baseline_valid = 0;
        s->uncertain = 1;
        ++s->faults;
        return; /* No old restore on a changed native codec configuration. */
    }
    if (s->phase != BM_WAIT || result || !bm_valid(baseline)) return;
    s->config = config;
    s->baseline = *baseline;
    s->baseline_valid = 1;
    if (s->accepted) s->phase = BM_READY;
}
static void restore(struct bm_state *s, uint64_t now) {
    s->phase = BM_RESTORE;
    s->call_started = s->call_returned = s->ack_seen = 0;
    s->ack_until = now + ACK_MS;
    ++s->restores;
}
int bm_request(struct bm_state *s, uint64_t epoch,
               const struct bm_insets *target, uint64_t now) {
    if (epoch != s->epoch || s->phase != BM_READY || s->used ||
        !s->baseline_valid || !bm_valid(target) || bm_equal(target, &s->baseline))
        return 0;
    s->requested = *target;
    s->used = s->dirty = 1;
    s->phase = BM_APPLY;
    s->lease_until = now + LEASE_MS;
    s->ack_until = now + ACK_MS;
    ++s->changes;
    return 1;
}
int bm_renew(struct bm_state *s, uint64_t epoch, uint64_t now) {
    if (epoch != s->epoch || s->stop || now >= s->lease_until ||
        (s->phase != BM_APPLY && s->phase != BM_ACTIVE)) return 0;
    s->lease_until = now + LEASE_MS;
    return 1;
}
int bm_rearm(struct bm_state *s, uint64_t epoch, uint64_t generation,
             uint64_t update_seq) {
    if (epoch != s->epoch || generation != s->generation ||
        update_seq != s->ack_count || s->phase != BM_DONE || !s->used ||
        !s->accepted || !s->baseline_valid || s->dirty || s->uncertain ||
        (s->call_started && (!s->call_returned || !s->ack_seen)) ||
        s->generation >= UINT64_C(9007199254740991)) return 0;
    ++s->generation;
    s->phase = BM_READY;
    s->used = s->stop = 0;
    s->call_started = s->call_returned = s->ack_seen = 0;
    s->lease_until = s->ack_until = 0;
    s->set_started_ns = 0;
    memset(&s->requested, 0, sizeof(s->requested));
    return 1;
}
void bm_stop(struct bm_state *s) {
    if (!s->used) return;
    s->stop = 1;
    if (s->phase == BM_APPLY && !s->call_started) {
        s->dirty = 0;
        s->phase = BM_DONE; /* Nothing reached Cinemo; do not send a restore. */
    }
}
void bm_tick(struct bm_state *s, uint64_t now) {
    if (s->used && now >= s->lease_until) bm_stop(s);
    if (s->phase == BM_ACTIVE && s->stop) restore(s, now);
    else if ((s->phase == BM_APPLY || s->phase == BM_RESTORE) &&
             now >= s->ack_until && s->call_returned) {
        ++s->faults;
        s->uncertain = 1;
        if (s->phase == BM_APPLY) restore(s, now);
        else s->phase = BM_BLOCKED;
    }
}
int bm_action(struct bm_state *s, uint64_t *epoch, struct bm_insets *out,
              uint64_t started_ns) {
    if ((s->phase != BM_APPLY && s->phase != BM_RESTORE) || s->call_started ||
        !s->accepted || !s->baseline_valid || !started_ns) return 0;
    s->call_started = 1;
    s->request_seq = s->ack_count;
    if (s->phase == BM_APPLY) s->set_started_ns = started_ns;
    *epoch = s->epoch;
    *out = s->phase == BM_APPLY ? s->requested : s->baseline;
    return 1;
}
static void acknowledged(struct bm_state *s, uint64_t now) {
    if (!s->ack_seen || !s->call_returned) return;
    if (s->phase == BM_APPLY) {
        s->phase = BM_ACTIVE;
        if (s->stop || now >= s->lease_until) restore(s, now);
    } else if (s->phase == BM_RESTORE) {
        s->dirty = 0;
        /* Convergence to the observed baseline, not a transaction ACK. A new
         * connection may explicitly rearm this exact clean observation. */
        s->phase = s->uncertain ? BM_BLOCKED : BM_DONE;
    }
}
void bm_call_result(struct bm_state *s, uint64_t epoch, int32_t result,
                    uint64_t now) {
    if (epoch != s->epoch || !s->call_started || s->call_returned ||
        (s->phase != BM_APPLY && s->phase != BM_RESTORE)) return;
    s->call_returned = 1;
    if (result) {
        s->uncertain = 1;
        ++s->faults;
        if (s->phase == BM_APPLY) restore(s, now);
        else s->phase = BM_BLOCKED;
    } else acknowledged(s, now);
}
void bm_ack(struct bm_state *s, uint32_t display, int has,
            const struct bm_insets *value, uint64_t now) {
    if (display || !has || !value) { ++s->ignored; return; }
    int any = 0;
    for (unsigned i = 0; i < 4; ++i) any |= value->present[i] != 0;
    if (!any) { ++s->ignored; return; }
    ++s->ack_count;
    if (s->phase == BM_WAIT) {
        /* An update preceding our source baseline makes that initial record
         * insufficient to claim the phone's current geometry. */
        s->phase = BM_BLOCKED;
        s->uncertain = 1;
        ++s->faults;
        return;
    }
    if (s->phase == BM_READY || s->phase == BM_ACTIVE || s->phase == BM_DONE) {
        const struct bm_insets *confirmed = s->phase == BM_ACTIVE ?
                                           &s->requested : &s->baseline;
        int differs = 0;
        for (unsigned i = 0; i < 4; ++i)
            if (value->present[i] && (value->present[i] != 1 ||
                value->value[i] != confirmed->value[i])) differs = 1;
        if (differs) {
            /* Native cache will receive this value after the callback. A late
             * or external update invalidates our previously confirmed state. */
            s->phase = BM_BLOCKED;
            s->uncertain = 1;
            s->dirty = s->used;
            s->baseline_valid = 0;
            ++s->faults;
        } else ++s->ignored;
        return;
    }
    if ((s->phase == BM_APPLY || s->phase == BM_RESTORE) && !s->call_started) {
        const struct bm_insets *before = s->phase == BM_APPLY ?
                                         &s->baseline : &s->requested;
        for (unsigned i = 0; i < 4; ++i) {
            if (value->present[i] && (value->present[i] != 1 ||
                value->value[i] != before->value[i])) {
                /* An external update before the call must not survive EOF
                 * as a clean cancellation with a now-obsolete baseline. */
                s->phase = BM_BLOCKED;
                s->uncertain = 1;
                s->baseline_valid = 0;
                ++s->faults;
                return;
            }
        }
        ++s->ignored;
        return;
    }
    if (s->phase != BM_APPLY && s->phase != BM_RESTORE) {
        ++s->ignored;
        return;
    }
    if (s->ack_count <= s->request_seq) { ++s->ignored; return; }
    if (now >= s->ack_until) { ++s->ignored; bm_tick(s, now); return; }
    const struct bm_insets *expected = s->phase == BM_APPLY ?
                                       &s->requested : &s->baseline;
    if (s->ack_seen) {
        for (unsigned i = 0; i < 4; ++i) {
            if (value->present[i] && (value->present[i] != 1 ||
                value->value[i] != expected->value[i])) {
                s->phase = BM_BLOCKED;
                s->uncertain = s->dirty = 1;
                s->baseline_valid = 0;
                ++s->faults;
                return;
            }
        }
    }
    if (!bm_valid(value)) { ++s->ignored; return; }
    if (!bm_equal(value, expected)) { ++s->ignored; return; }
    s->ack_seen = 1;
    acknowledged(s, now);
}
const char *bm_name(enum bm_phase phase) {
    static const char *const names[] = {"off", "waiting-baseline", "ready",
        "applying", "active", "restoring", "done", "blocked"};
    return phase <= BM_BLOCKED ? names[phase] : "invalid";
}
