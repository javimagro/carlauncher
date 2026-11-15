/* SPDX-License-Identifier: MIT. Native functions are simulated, never loaded. */
#include "bridge-state.h"
#include <stdio.h>
#include <string.h>
static unsigned tests, failures;
#define CHECK(x) do { ++tests; if (!(x)) { ++failures; \
    fprintf(stderr, "line %d: %s\n", __LINE__, #x); } } while (0)
static const struct bm_insets baseline = {{1,1,1,1}, {248,248,0,0}};
static const struct bm_insets target = {{1,1,1,1}, {250,250,312,312}};
static uint64_t ready(struct bm_state *s) {
    bm_init(s);
    uint64_t epoch = bm_begin(s);
    bm_begin_result(s, epoch, 0);
    bm_config(s, 0, 0, 0, &baseline);
    CHECK(s->phase == BM_READY);
    return epoch;
}
static void action(struct bm_state *s, uint64_t expected, const struct bm_insets *value) {
    uint64_t epoch = 0;
    struct bm_insets out;
    CHECK(bm_action(s, &epoch, &out, 1000000));
    CHECK(epoch == expected);
    CHECK(bm_equal(&out, value));
    CHECK(!bm_action(s, &epoch, &out, 1000000));
}
static void success_and_lease(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    CHECK(!bm_request(&s, e + 1, &target, 10));
    CHECK(!bm_request(&s, e, &baseline, 10));
    CHECK(bm_request(&s, e, &target, 10));
    CHECK(!bm_request(&s, e, &target, 10));
    action(&s, e, &target);
    bm_call_result(&s, e, 0, 20);
    CHECK(s.phase == BM_APPLY); /* Local return is not an ACK. */
    bm_ack(&s, 1, 1, &target, 30);
    CHECK(s.phase == BM_APPLY); /* IC must not acknowledge MAIN. */
    bm_ack(&s, 0, 1, &baseline, 30);
    CHECK(s.phase == BM_APPLY);
    bm_ack(&s, 0, 1, &target, 40);
    CHECK(s.phase == BM_ACTIVE);
    CHECK(bm_renew(&s, e, 1000));
    CHECK(!bm_renew(&s, e + 1, 1100));
    bm_tick(&s, 1999);
    CHECK(s.phase == BM_ACTIVE);
    bm_tick(&s, 2000);
    CHECK(s.phase == BM_RESTORE);
    CHECK(!bm_renew(&s, e, 2000));
    action(&s, e, &baseline);
    bm_ack(&s, 0, 1, &baseline, 2010); /* ACK before local return. */
    CHECK(s.phase == BM_RESTORE);
    bm_call_result(&s, e, 0, 2020);
    CHECK(s.phase == BM_DONE && !s.dirty && !s.uncertain);
    CHECK(!bm_request(&s, e, &target, 2100));
}
static void baseline_rules(void) {
    struct bm_state s;
    bm_init(&s);
    CHECK(!bm_request(&s, 0, &target, 0));
    uint64_t e = bm_begin(&s);
    struct bm_insets partial = baseline;
    partial.present[0] = 0;
    bm_config(&s, 1, 0, 0, &baseline);
    CHECK(!s.baseline_valid);
    bm_config(&s, 0, 0, 118, &baseline);
    CHECK(!s.baseline_valid);
    bm_config(&s, 0, 0, 0, &partial);
    CHECK(!s.baseline_valid);
    bm_config(&s, 0, 0, 0, &baseline);
    CHECK(s.baseline_valid && s.phase == BM_WAIT);
    CHECK(!bm_request(&s, e, &target, 0));
    bm_begin_result(&s, e, 0);
    CHECK(s.phase == BM_READY);
    bm_config(&s, 0, 0, 0, &target);
    CHECK(bm_equal(&s.baseline, &baseline));
    bm_config(&s, 1, 1, 0, &target);
    CHECK(s.phase == BM_READY);
    bm_config(&s, 0, 1, 0, &target);
    CHECK(s.phase == BM_BLOCKED && !s.baseline_valid);
    e = bm_begin(&s);
    bm_begin_result(&s, e, 13);
    bm_config(&s, 0, 0, 0, &baseline);
    CHECK(s.phase == BM_BLOCKED && !s.baseline_valid);
}
static void eof_and_timeouts(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_stop(&s);
    CHECK(!bm_renew(&s, e, 50));
    bm_ack(&s, 0, 1, &target, 100);
    CHECK(s.phase == BM_APPLY);
    bm_call_result(&s, e, 0, 101);
    CHECK(s.phase == BM_RESTORE);
    action(&s, e, &baseline);
    bm_call_result(&s, e, 0, 110);
    bm_tick(&s, 2101);
    CHECK(s.phase == BM_BLOCKED && s.dirty);
    bm_ack(&s, 0, 1, &baseline, 2110);
    CHECK(s.phase == BM_BLOCKED && s.dirty);
    e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_call_result(&s, e, 0, 10);
    bm_ack(&s, 0, 1, &target, 2000); /* Late ACK cannot win timer scheduling. */
    CHECK(s.phase == BM_RESTORE && s.uncertain);
    action(&s, e, &baseline);
    bm_call_result(&s, e, 0, 2010);
    bm_ack(&s, 0, 1, &baseline, 2020);
    CHECK(s.phase == BM_BLOCKED && !s.dirty);
    CHECK(!bm_request(&s, e, &target, 2100));
}
static void epoch_and_errors(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_end(&s);
    bm_call_result(&s, e, 0, 20);
    bm_ack(&s, 0, 1, &target, 30);
    CHECK(s.phase == BM_OFF && !s.baseline_valid);
    uint64_t next = bm_begin(&s);
    CHECK(next != e);
    bm_begin_result(&s, e, 0);
    CHECK(!s.accepted);
    bm_config(&s, 0, 0, 0, &baseline);
    bm_begin_result(&s, next, 0);
    CHECK(!bm_request(&s, e, &target, 40));
    CHECK(bm_request(&s, next, &target, 40));
    action(&s, next, &target);
    bm_call_result(&s, next, 12, 50);
    CHECK(s.phase == BM_RESTORE && s.uncertain);
    action(&s, next, &baseline);
    bm_call_result(&s, next, 13, 60);
    CHECK(s.phase == BM_BLOCKED && s.dirty);
    /* No timeout can manufacture completion while a native call is blocked. */
    e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_tick(&s, 100000);
    CHECK(s.phase == BM_APPLY && !s.call_returned);
    CHECK(!bm_renew(&s, e, 100001));
}
static void contradictory_late_ack(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    bm_ack(&s, 0, 1, &target, 0);
    CHECK(s.phase == BM_BLOCKED && !s.baseline_valid);
    e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_call_result(&s, e, 0, 10);
    bm_ack(&s, 0, 1, &target, 20);
    bm_ack(&s, 0, 1, &baseline, 30);
    CHECK(s.phase == BM_BLOCKED && s.dirty && s.uncertain);
    e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_call_result(&s, e, 0, 10);
    bm_ack(&s, 0, 1, &target, 20);
    bm_stop(&s);
    bm_tick(&s, 30);
    action(&s, e, &baseline);
    bm_call_result(&s, e, 0, 40);
    bm_ack(&s, 0, 1, &baseline, 50);
    CHECK(s.phase == BM_DONE);
    bm_ack(&s, 0, 1, &target, 60);
    CHECK(s.phase == BM_BLOCKED && s.dirty && s.uncertain);
    CHECK(!bm_request(&s, e, &target, 70));
}
static void cancelled_before_call(void) {
    struct bm_state s;
    struct bm_insets out;
    uint64_t e = ready(&s), actual;
    CHECK(bm_request(&s, e, &target, 0));
    bm_stop(&s);
    bm_tick(&s, 1);
    CHECK(!bm_action(&s, &actual, &out, 1000000));
    CHECK(s.phase == BM_DONE && !s.dirty && !s.restores);
    e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    bm_tick(&s, 1000);
    CHECK(!bm_action(&s, &actual, &out, 1000000));
    CHECK(s.phase == BM_DONE && !s.dirty && !s.restores);
}
static void partial_update(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_call_result(&s, e, 0, 10);
    bm_ack(&s, 0, 1, &target, 20);
    struct bm_insets partial = {{0,0,0,0}, {0,0,0,0}};
    bm_ack(&s, 0, 0, &partial, 25); /* Theme-only does not clear margins. */
    bm_ack(&s, 0, 1, &partial, 26); /* Empty Insets merge is a no-op. */
    CHECK(s.phase == BM_ACTIVE);
    partial.present[2] = 1;
    partial.value[2] = 312;
    bm_ack(&s, 0, 1, &partial, 27);
    CHECK(s.phase == BM_ACTIVE);
    partial.value[2] = 0;
    bm_ack(&s, 1, 1, &partial, 28);
    CHECK(s.phase == BM_ACTIVE);
    bm_ack(&s, 0, 1, &partial, 29);
    CHECK(s.phase == BM_BLOCKED && s.uncertain && s.dirty);
    bm_begin(&s);
    bm_ack(&s, 0, 1, &partial, 30);
    CHECK(s.phase == BM_BLOCKED && !s.baseline_valid);
}
static void update_before_local_return(void) {
    for (int restoring = 0; restoring < 2; ++restoring) {
        for (int partial = 0; partial < 2; ++partial) {
            struct bm_state s;
            uint64_t e = ready(&s);
            CHECK(bm_request(&s, e, &target, 0));
            action(&s, e, &target);
            if (restoring) {
                bm_call_result(&s, e, 0, 5);
                bm_ack(&s, 0, 1, &target, 10);
                bm_stop(&s); bm_tick(&s, 15);
                action(&s, e, &baseline);
            }
            const struct bm_insets *expected = restoring ? &baseline : &target;
            struct bm_insets later = restoring ? target : baseline;
            if (partial) {
                for (unsigned i = 0; i < 4; ++i) later.present[i] = i == 2;
            }
            bm_ack(&s, 0, 1, expected, 20);
            CHECK(s.ack_seen && !s.call_returned);
            bm_ack(&s, 0, 1, &later, 21);
            bm_call_result(&s, e, 0, 22);
            CHECK(s.phase == BM_BLOCKED && s.uncertain && s.dirty);
        }
    }
}
static void control_reconnect_is_not_new_epoch(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    CHECK(!bm_rearm(&s, e, s.generation, s.ack_count));
    CHECK(bm_request(&s, e, &target, 0));
    action(&s, e, &target);
    bm_call_result(&s, e, 0, 10);
    bm_ack(&s, 0, 1, &target, 20);
    bm_stop(&s); bm_tick(&s, 30);
    action(&s, e, &baseline);
    bm_call_result(&s, e, 0, 40);
    bm_ack(&s, 0, 1, &baseline, 50);
    CHECK(s.phase == BM_DONE && !s.dirty && !s.uncertain);
    struct bm_state confirmed = s;
    CHECK(!bm_rearm(&s, e, s.generation + 1, s.ack_count));
    CHECK(!bm_rearm(&s, e + 1, s.generation, s.ack_count));
    CHECK(!bm_rearm(&s, e, s.generation, s.ack_count + 1));
    CHECK(!memcmp(&confirmed, &s, sizeof(s)));
    bm_config(&s, 0, 0, 0, &baseline); /* A repeat config cannot rearm us. */
    CHECK(!bm_request(&s, e, &target, 60));
    CHECK(!bm_renew(&s, e, 60));
    bm_end(&s);
    uint64_t next = bm_begin(&s);
    bm_begin_result(&s, next, 0);
    CHECK(!bm_request(&s, next, &target, 70));
    bm_config(&s, 0, 0, 0, &baseline);
    CHECK(!bm_request(&s, e, &target, 80));
    CHECK(bm_request(&s, next, &target, 80));
}
static void repeated_convergence(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    for (unsigned iteration = 0; iteration < 3; ++iteration) {
        CHECK(s.generation == iteration + 1);
        CHECK(!s.set_started_ns);
        uint64_t prior = s.ack_count;
        CHECK(bm_request(&s, e, &target, iteration * 100));
        bm_ack(&s, 0, 1, &baseline, iteration * 100 + 1);
        CHECK(!s.ack_seen && !s.call_started); /* Queued old update cannot confirm. */
        struct bm_insets out;
        uint64_t call_epoch, started = UINT64_C(10000000000) + iteration * 100;
        CHECK(!bm_action(&s, &call_epoch, &out, 0));
        CHECK(bm_action(&s, &call_epoch, &out, started));
        CHECK(s.set_started_ns == started && s.request_seq > prior);
        bm_call_result(&s, e, 0, iteration * 100 + 10);
        bm_ack(&s, 0, 1, &baseline, iteration * 100 + 15);
        CHECK(s.phase == BM_APPLY && !s.ack_seen);
        bm_ack(&s, 0, 1, &target, iteration * 100 + 20);
        CHECK(s.phase == BM_ACTIVE && s.ack_count > s.request_seq);
        bm_stop(&s); bm_tick(&s, iteration * 100 + 30);
        action(&s, e, &baseline);
        CHECK(s.set_started_ns == started); /* Restore does not move GOP boundary. */
        bm_call_result(&s, e, 0, iteration * 100 + 40);
        bm_ack(&s, 0, 1, &baseline, iteration * 100 + 50);
        CHECK(s.phase == BM_DONE && !s.dirty && !s.uncertain);
        CHECK(bm_rearm(&s, e, s.generation, s.ack_count));
        CHECK(s.phase == BM_READY && !s.used && !s.stop && !s.set_started_ns);
        CHECK(bm_equal(&s.baseline, &baseline));
    }
    /* A contrary update after restoration blocks rearm and does not write
     * over an externally changed configuration. */
    bm_ack(&s, 0, 1, &target, 400);
    CHECK(s.phase == BM_BLOCKED && !s.baseline_valid);
    CHECK(!bm_rearm(&s, e, s.generation, s.ack_count));
}
static void stale_rearm_observation(void) {
    struct bm_state s;
    uint64_t e = ready(&s);
    CHECK(bm_request(&s, e, &target, 0));
    bm_stop(&s); /* No call: clean cancellation can also be rearmed. */
    uint64_t seq = s.ack_count;
    bm_ack(&s, 0, 1, &baseline, 10);
    CHECK(!bm_rearm(&s, e, s.generation, seq));
    CHECK(bm_rearm(&s, e, s.generation, s.ack_count));
    CHECK(bm_request(&s, e, &target, 20));
    action(&s, e, &target);
    bm_stop(&s);
    CHECK(!bm_rearm(&s, e, s.generation, s.ack_count));
    bm_ack(&s, 0, 1, &target, 30);
    bm_call_result(&s, e, 0, 40);
    CHECK(s.phase == BM_RESTORE);
    CHECK(!bm_rearm(&s, e, s.generation, s.ack_count));
    action(&s, e, &baseline);
    bm_call_result(&s, e, 0, 50);
    bm_tick(&s, 2040);
    CHECK(s.phase == BM_BLOCKED);
    CHECK(!bm_rearm(&s, e, s.generation, s.ack_count));
}
static void update_before_setter_then_eof(void) {
    for (unsigned partial = 0; partial < 2; ++partial) {
        struct bm_state s;
        uint64_t e = ready(&s), call_epoch;
        struct bm_insets changed = target, out;
        if (partial) for (unsigned i = 0; i < 4; ++i) changed.present[i] = i == 2;
        CHECK(bm_request(&s, e, &target, 0));
        bm_ack(&s, 0, 1, &changed, 1);
        bm_stop(&s); bm_tick(&s, 2);
        CHECK(s.phase == BM_BLOCKED && s.uncertain && !s.baseline_valid);
        CHECK(!s.set_started_ns);
        CHECK(!bm_action(&s, &call_epoch, &out, 1000000));
        CHECK(!bm_rearm(&s, e, s.generation, s.ack_count));
    }
}
int baseline_tests(void);
int profile_tests(void);
int protocol_tests(void);
int main(void) {
    success_and_lease(); baseline_rules(); eof_and_timeouts(); epoch_and_errors();
    contradictory_late_ack();
    cancelled_before_call();
    partial_update();
    update_before_local_return();
    control_reconnect_is_not_new_epoch();
    repeated_convergence(); stale_rearm_observation();
    update_before_setter_then_eof();
    printf("MAIN bridge model: %u checks, %u failures\n", tests, failures);
    int baseline_failed = baseline_tests();
    int profile_failed = profile_tests();
    int protocol_failed = protocol_tests();
    return baseline_failed || profile_failed || protocol_failed || failures ? 1 : 0;
}
