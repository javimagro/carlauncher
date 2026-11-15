/* SPDX-License-Identifier: MIT. Synthetic process records, no private data. */
#include "bridge-protocol.h"
#include <stdio.h>
#include <string.h>
static unsigned checks, failures;
#define CHECK(x) do { ++checks; if (!(x)) { ++failures; \
    fprintf(stderr, "protocol line %d: %s\n", __LINE__, #x); } } while (0)
static void commands(void) {
    struct bm_command c;
    CHECK(bm_parse_command("GET", &c) && c.kind == BM_CMD_GET);
    CHECK(bm_parse_command("CLOSE", &c) && c.kind == BM_CMD_CLOSE);
    CHECK(bm_parse_command("SET 42 normal", &c) && c.kind == BM_CMD_SET && c.epoch == 42);
    CHECK(bm_valid(&c.insets) && c.insets.value[0] == 250 && c.insets.value[1] == 250 &&
          c.insets.value[2] == 312 && c.insets.value[3] == 312);
    CHECK(bm_parse_command("SET 43 alto", &c) && c.epoch == 43 && c.insets.value[2] == 376);
    CHECK(bm_parse_command("LEASE 1", &c) && c.kind == BM_CMD_LEASE);
    CHECK(bm_parse_command("RESTORE 1", &c) && c.kind == BM_CMD_RESTORE);
    CHECK(bm_parse_command("REARM 1 2 3", &c) && c.kind == BM_CMD_REARM &&
          c.epoch == 1 && c.generation == 2 && c.update_seq == 3);
    CHECK(bm_parse_command("REARM 1 1 0", &c) && !c.update_seq);
    const char *bad[] = {"", "GET 1", "CLOSE 1", "SET 0 alto", "SET -1 alto",
        "SET 1", "SET 1 ic", "SET 1 MAIN", "SET 1 alto extra", "SET  1 alto",
        "SET 18446744073709551616 alto", "SET 1\talto", "LEASE 1 alto", "REARM",
        "RESTORE 1 ", "RESTORE +1", "LEASE 1\n", "SET 1 376 250",
        "REARM 1", "REARM 1 0 0", "REARM 1 1 -1", "REARM 1 1 0 extra"};
    for (unsigned i = 0; i < sizeof(bad) / sizeof(*bad); ++i)
        CHECK(!bm_parse_command(bad[i], &c));
    char oversized[129]; memset(oversized, '1', sizeof(oversized)); oversized[128] = 0;
    CHECK(!bm_parse_command(oversized, &c));
    CHECK(!bm_parse_command(NULL, &c));
    CHECK(!bm_parse_command("GET", NULL));
}
static void process_identity(void) {
    const char *record = "42 (aapd) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 123456 20 21\n";
    uint64_t start = 0;
    CHECK(bm_parse_starttime(record, 42, &start) && start == 123456);
    CHECK(!bm_parse_starttime(record, 43, &start));
    CHECK(!bm_parse_starttime(record, 1, &start));
    CHECK(!bm_parse_starttime(NULL, 42, &start));
    CHECK(!bm_parse_starttime(record, 42, NULL));
    CHECK(!bm_parse_starttime("42 (aapd) S 1 2", 42, &start));
    char altered[256];
    strcpy(altered, record); altered[10] = 'Z';
    CHECK(!bm_parse_starttime(altered, 42, &start));
    strcpy(altered, record); altered[5] = 'b';
    CHECK(!bm_parse_starttime(altered, 42, &start));
    CHECK(!bm_parse_starttime("42 (aapd) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 0 20", 42, &start));
    CHECK(!bm_parse_starttime("42 (aapd) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 18446744073709551616 20", 42, &start));
}
static void connection_ownership(void) {
    struct bm_state state;
    struct bm_command cmd;
    struct bm_insets base = {{1,1,1,1}, {248,248,0,0}}, out;
    uint64_t owner = 0, observer = 0, call_epoch;
    bm_init(&state);
    uint64_t epoch = bm_begin(&state);
    CHECK(epoch == 1);
    bm_begin_result(&state, epoch, 0);
    bm_config(&state, 0, 0, 0, &base);
    CHECK(bm_parse_command("SET 1 alto", &cmd));
    CHECK(!bm_control(&state, &owner, &cmd, 0, 0));
    CHECK(!owner && state.phase == BM_READY);
    CHECK(bm_control(&state, &owner, &cmd, 1, 0) && owner == epoch);
    CHECK(bm_action(&state, &call_epoch, &out, 1000000));
    bm_call_result(&state, epoch, 0, 10);
    bm_ack(&state, 0, 1, &out, 20);
    CHECK(state.phase == BM_ACTIVE);
    bm_disconnect(&state, &observer);
    CHECK(!state.stop && state.phase == BM_ACTIVE);
    CHECK(bm_parse_command("RESTORE 1", &cmd));
    CHECK(!bm_control(&state, &observer, &cmd, 1, 30));
    CHECK(!state.stop);
    CHECK(bm_parse_command("LEASE 1", &cmd));
    CHECK(!bm_control(&state, &observer, &cmd, 1, 30));
    CHECK(bm_control(&state, &owner, &cmd, 1, 30));
    bm_disconnect(&state, &owner);
    CHECK(!owner && state.stop);
    bm_tick(&state, 40);
    CHECK(state.phase == BM_RESTORE);
    bm_end(&state);
    epoch = bm_begin(&state);
    bm_begin_result(&state, epoch, 0);
    bm_config(&state, 0, 0, 0, &base);
    owner = 1; /* Old TCP owner cannot control a later native epoch. */
    bm_disconnect(&state, &owner);
    CHECK(!state.stop && state.phase == BM_READY);
    CHECK(bm_parse_command("SET 3 alto", &cmd));
    CHECK(bm_control(&state, &owner, &cmd, 1, 100));
    bm_disconnect(&state, &owner); /* SET and CLOSE in the same recv. */
    CHECK(state.phase == BM_DONE && !state.dirty && !state.restores);
    CHECK(!bm_action(&state, &call_epoch, &out, 1000000));
    CHECK(bm_parse_command("REARM 3 1 0", &cmd));
    owner = 3; /* The previous connection cannot rearm its own acquisition. */
    CHECK(!bm_control(&state, &owner, &cmd, 1, 110));
    CHECK(state.phase == BM_DONE);
    bm_disconnect(&state, &owner);
    CHECK(bm_control(&state, &observer, &cmd, 1, 120));
    CHECK(state.phase == BM_READY && state.generation == 2 && !observer);
    bm_disconnect(&state, &observer);
    CHECK(!state.stop && state.phase == BM_READY); /* REARM alone does not own SET. */
    CHECK(bm_parse_command("SET 3 normal", &cmd));
    CHECK(bm_control(&state, &observer, &cmd, 1, 130));
    CHECK(observer == 3);
    bm_disconnect(&state, &observer);
    CHECK(state.phase == BM_DONE && !state.dirty);
}
int protocol_tests(void) {
    commands(); process_identity(); connection_ownership();
    printf("Control protocol: %u checks, %u failures\n", checks, failures);
    return failures != 0;
}
