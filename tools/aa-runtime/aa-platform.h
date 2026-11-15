/* SPDX-License-Identifier: MIT */
#ifndef BMW_AA_PLATFORM_H
#define BMW_AA_PLATFORM_H
#include "aa-capture.h"
#include <sys/stat.h>
#include <sys/types.h>
struct aa_target { uint32_t pid; uint64_t starttime; struct stat executable,library; };
struct aa_channel { int fd[AA_MAX_WINDOWS]; void *mapping; unsigned char *ring; size_t size,mapping_size; uint64_t tail; };
struct aa_trace {
    char root[80],group[80];
    uint32_t windows,created,ids[AA_MAX_WINDOWS];
    int cpus,events_fd,lock_fd,guard_fd; pid_t guard_pid;
    struct aa_channel cpu[AA_MAX_CPUS];
};
typedef int (*aa_pulse_fn)(void *);
uint64_t aa_now(void);
void aa_log(const char *type,const char *code,int number);
int aa_starttime(uint32_t pid,uint64_t *starttime);
int aa_target_find(struct aa_target *target,uint32_t pid,uint64_t expected,const char **reason);
int aa_target_current(const struct aa_target *target);
int aa_trace_available(struct aa_trace *trace);
int aa_trace_open(struct aa_trace *trace,const struct aa_target *target,uint32_t windows,uint32_t lease_ms,
                  aa_pulse_fn pulse,void *context);
int aa_trace_enable(struct aa_trace *trace);
int aa_trace_drain(struct aa_trace *trace,struct aa_stream *stream,aa_pulse_fn pulse,void *context);
void aa_trace_close(struct aa_trace *trace);
int aa_trace_heartbeat(struct aa_trace *trace);
int aa_owner_open(struct aa_trace *trace,uint32_t windows,uint32_t lease_ms);
void aa_owner_close(struct aa_trace *trace);
int aa_remove_events(const char *root,const char *group,uint32_t windows);
#endif
