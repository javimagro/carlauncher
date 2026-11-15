/* SPDX-License-Identifier: MIT. Bounded control grammar, no native calls. */
#ifndef BMW_MAIN_BRIDGE_PROTOCOL_H
#define BMW_MAIN_BRIDGE_PROTOCOL_H
#include "bridge-state.h"
enum bm_command_kind { BM_CMD_GET, BM_CMD_CLOSE, BM_CMD_SET, BM_CMD_LEASE,
                       BM_CMD_RESTORE, BM_CMD_REARM };
struct bm_command {
    enum bm_command_kind kind;
    uint64_t epoch, generation, update_seq;
    struct bm_insets insets;
};
int bm_parse_command(const char *line, struct bm_command *out);
int bm_parse_starttime(const char *line, uint32_t pid, uint64_t *out);
/* Caller serializes state. A control connection owns only its accepted SET. */
int bm_control(struct bm_state *state, uint64_t *owned_epoch,
               const struct bm_command *command, int writes, uint64_t now);
void bm_disconnect(struct bm_state *state, uint64_t *owned_epoch);
#endif
