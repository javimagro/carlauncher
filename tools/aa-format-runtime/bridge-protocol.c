/* SPDX-License-Identifier: MIT */
#include "bridge-protocol.h"
#include <stdio.h>
#include <string.h>
static int number(const char *first, const char *last, uint64_t *out) {
    if (first == last) return 0;
    uint64_t value = 0;
    for (const char *p = first; p < last; ++p) {
        if (*p < '0' || *p > '9') return 0;
        unsigned digit = (unsigned)(*p - '0');
        if (value > (UINT64_MAX - digit) / 10) return 0;
        value = value * 10 + digit;
    }
    *out = value;
    return 1;
}
int bm_parse_command(const char *line, struct bm_command *out) {
    if (!line || !out || strlen(line) >= 128) return 0;
    struct bm_command value;
    memset(&value, 0, sizeof(value));
    if (!strcmp(line, "GET")) value.kind = BM_CMD_GET;
    else if (!strcmp(line, "CLOSE")) value.kind = BM_CMD_CLOSE;
    else {
        const char *first = strchr(line, ' ');
        if (!first) return 0;
        size_t length = (size_t)(first - line);
        if (length == 3 && !memcmp(line, "SET", 3)) value.kind = BM_CMD_SET;
        else if (length == 5 && !memcmp(line, "LEASE", 5)) value.kind = BM_CMD_LEASE;
        else if (length == 7 && !memcmp(line, "RESTORE", 7)) value.kind = BM_CMD_RESTORE;
        else if (length == 5 && !memcmp(line, "REARM", 5)) value.kind = BM_CMD_REARM;
        else return 0;
        ++first;
        const char *last = strchr(first, ' ');
        if (value.kind == BM_CMD_REARM) {
            if (!last) return 0;
            const char *sequence = strchr(last + 1, ' ');
            if (!sequence || !number(last + 1, sequence, &value.generation) ||
                !value.generation ||
                !number(sequence + 1, sequence + strlen(sequence), &value.update_seq)) return 0;
        } else if (value.kind == BM_CMD_SET) {
            if (!last) return 0;
            uint32_t side;
            if (!strcmp(last + 1, "normal")) side = 312;
            else if (!strcmp(last + 1, "alto")) side = 376;
            else return 0;
            for (unsigned i = 0; i < 4; ++i) value.insets.present[i] = 1;
            value.insets.value[0] = value.insets.value[1] = 250;
            value.insets.value[2] = value.insets.value[3] = side;
        } else if (last) return 0;
        else last = first + strlen(first);
        if (!number(first, last, &value.epoch) || !value.epoch) return 0;
    }
    *out = value;
    return 1;
}
int bm_parse_starttime(const char *line, uint32_t pid, uint64_t *out) {
    if (!line || !out || pid <= 1 || strlen(line) >= 4096) return 0;
    char prefix[32];
    int length = snprintf(prefix, sizeof(prefix), "%u (aapd) ", pid);
    if (length < 0 || (size_t)length >= sizeof(prefix) ||
        strncmp(line, prefix, (size_t)length)) return 0;
    const char *p = line + length;
    if (*p < 'A' || *p > 'Z' || *p == 'Z' || *p == 'X' || p[1] != ' ') return 0;
    p += 2; /* The following first field is ppid (field 4). */
    for (unsigned field = 4; field <= 22; ++field) {
        const char *last = strchr(p, ' ');
        if (!last) return 0;
        if (field == 22) return number(p, last, out) && *out != 0;
        if (last == p) return 0;
        p = last + 1;
    }
    return 0;
}
int bm_control(struct bm_state *state, uint64_t *owned_epoch,
               const struct bm_command *command, int writes, uint64_t now) {
    int ok = 0;
    if (writes && command->kind == BM_CMD_SET) {
        ok = bm_request(state, command->epoch, &command->insets, now);
        if (ok) *owned_epoch = command->epoch;
    } else if (command->kind == BM_CMD_LEASE && *owned_epoch == command->epoch)
        ok = bm_renew(state, command->epoch, now);
    else if (command->kind == BM_CMD_REARM && !*owned_epoch)
        ok = bm_rearm(state, command->epoch, command->generation, command->update_seq);
    else if (command->kind == BM_CMD_RESTORE && *owned_epoch == command->epoch &&
             command->epoch == state->epoch) {
        bm_stop(state);
        ok = 1;
    }
    return ok;
}
void bm_disconnect(struct bm_state *state, uint64_t *owned_epoch) {
    if (*owned_epoch && *owned_epoch == state->epoch) bm_stop(state);
    *owned_epoch = 0;
}
