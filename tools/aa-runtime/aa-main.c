/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "aa-platform.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/uio.h>
#include <unistd.h>
int aa_self_test(void);
struct runtime {
    struct aa_trace trace;
    struct aa_target target;
    struct aa_control control;
    struct aa_stream stream;
    uint64_t guard_due,identity_due,stop_time,output_bytes,write_started;
    size_t write_offset;
    int writing,trace_initialized;
    const char *stop_reason;
};
static struct runtime runtime;
static volatile sig_atomic_t interrupted;
static void stop_signal(int number) { (void)number;interrupted=1; }
static void cleanup(void) { if(runtime.trace_initialized) aa_trace_close(&runtime.trace); }
static int number(const char *s,uint64_t maximum,uint64_t *value) {
    if(!s || *s<'0'||*s>'9') return -1;
    char *end;errno=0;unsigned long long n=strtoull(s,&end,10);
    if(errno||*end||n==0||n>maximum) return -1;*value=n;return 0;
}
static int pulse(void *context) {
    struct runtime *r=context;uint64_t now=aa_now();
    if(interrupted) { r->stop_reason="signal";return -1; }
    if(!aa_control_alive(&r->control,now)) { r->stop_reason=r->control.stopped ? "stop" : "lease-expired";return -1; }
    unsigned char input[256];unsigned reads=0;
    for(;;) {
        ssize_t n=read(STDIN_FILENO,input,sizeof(input));
        if(n>0) { if(aa_control_feed(&r->control,input,(size_t)n,now)) { r->stop_reason="invalid-control";return -1; } }
        else if(n==0) { r->control.stopped=1;r->stop_reason="stdin-eof";return -1; }
        else if(errno==EAGAIN||errno==EWOULDBLOCK) break;
        else if(errno!=EINTR) { r->stop_reason="stdin-error";return -1; }
        if(++reads==16) { r->stop_reason="control-overflow";return -1; }
    }
    if(!aa_control_alive(&r->control,now)) { r->stop_reason=r->control.stopped ? "stop" : "lease-expired";return -1; }
    if(r->stop_time && now>=r->stop_time) { r->stop_reason="duration-complete";return -1; }
    if(r->trace.guard_fd>=0 && now>=r->guard_due) {
        if(aa_trace_heartbeat(&r->trace)) { r->stop_reason="guardian-unavailable";return -1; }
        r->guard_due=now+250000000ULL;
    }
    return 0;
}
static void report_stats(const struct runtime *r) {
    const struct aa_counts *c=&r->stream.counts;char line[1024];
#define U(v) ((unsigned long long)(v))
    int n=snprintf(line,sizeof(line),"{\"type\":\"stats\",\"frames\":%llu,\"samples\":%llu,\"complete\":%llu,\"outputBytes\":%llu,\"payloadBytes\":%llu,\"lost\":%llu,\"malformed\":%llu,\"incomplete\":%llu,\"oversized\":%llu,\"late\":%llu,\"queueHigh\":%llu,\"maxLength\":%llu,\"maxLagNs\":%llu,\"maxSpanNs\":%llu}\n",
        U(c->emitted),U(c->samples),U(c->complete),U(r->output_bytes),U(c->payload_bytes),U(c->lost),U(c->malformed),
        U(c->incomplete),U(c->oversized),U(c->late),U(c->queue_high),U(c->max_length),U(c->max_lag_ns),U(c->max_span_ns));
    if(n>0 && (size_t)n<sizeof(line)) (void)write(STDERR_FILENO,line,(size_t)n);
}
static int output_step(struct runtime *r,uint64_t now) {
    if(r->writing<0) {
        r->writing=aa_stream_next(&r->stream,now);
        if(r->writing<0) return r->stream.error ? -1 : 0;
        r->write_offset=0;r->write_started=now;
    }
    if(now-r->write_started>250000000ULL) { r->stop_reason="output-backpressure";return -1; }
    struct aa_slot *a=&r->stream.slots[r->writing];struct iovec vectors[2];int count=0;
    if(r->write_offset<64) vectors[count++]=(struct iovec){(unsigned char *)&a->header+r->write_offset,64-r->write_offset};
    size_t payload_offset=r->write_offset>64 ? r->write_offset-64 : 0;
    vectors[count++]=(struct iovec){a->payload+payload_offset,a->header.total_size-payload_offset};
    ssize_t n=writev(STDOUT_FILENO,vectors,count);
    if(n>0) { r->write_offset+=(size_t)n;r->output_bytes+=(uint64_t)n; }
    else if(n<0 && errno!=EINTR && errno!=EAGAIN && errno!=EWOULDBLOCK) { r->stop_reason="stdout-closed";return -1; }
    if(r->write_offset==64+a->header.total_size) { aa_stream_done(&r->stream,(unsigned)r->writing);r->writing=-1; }
    return 0;
}
static void recovery(const struct aa_stream *stream) {
    char line[256];int n=snprintf(line,sizeof(line),
        "{\"type\":\"recovery-needed\",\"code\":\"%s\",\"requiredBytes\":%u,\"maxFrame\":%u}\n",
        aa_stream_reason(stream->error),stream->required_bytes,AA_MAX_FRAME);
    if(n>0 && (size_t)n<sizeof(line)) (void)write(STDERR_FILENO,line,(size_t)n);
}
int main(int argc,char **argv) {
    uint64_t pid=0,starttime=0,initial=AA_INITIAL_BYTES,lease_ms=1000,max_seconds=0;int check=0;
    for(int i=1;i<argc;i++) {
        const char *arg=argv[i];
        if(!strcmp(arg,"--self-test") && argc==2) return aa_self_test();
        if(!strcmp(arg,"--check")) { check=1;continue; }
        if(!strcmp(arg,"--profile") && i+1<argc && !strcmp(argv[++i],AA_PROFILE)) continue;
        uint64_t *value=NULL,maximum=0;
        if(!strcmp(arg,"--pid")) { value=&pid;maximum=INT32_MAX; }
        else if(!strcmp(arg,"--starttime")) { value=&starttime;maximum=UINT64_MAX; }
        else if(!strcmp(arg,"--initial-bytes")) { value=&initial;maximum=AA_MAX_FRAME; }
        else if(!strcmp(arg,"--lease-ms")) { value=&lease_ms;maximum=1000; }
        else if(!strcmp(arg,"--max-seconds")) { value=&max_seconds;maximum=3600; }
        if(!value||i+1>=argc||number(argv[++i],maximum,value)) { aa_log("error","invalid-arguments",0);return 64; }
    }
    if(lease_ms<500 || (!check && (!pid||!starttime))) { aa_log("error","pid-starttime-required",0);return 64; }
    int stderr_flags=fcntl(STDERR_FILENO,F_GETFL);if(stderr_flags>=0) (void)fcntl(STDERR_FILENO,F_SETFL,stderr_flags|O_NONBLOCK);
    const char *reason=NULL;
    if(aa_target_find(&runtime.target,(uint32_t)pid,starttime,&reason)) { aa_log("error",reason,errno);return 65; }
    if(aa_trace_available(&runtime.trace)) { aa_log("error","capture-unavailable",errno);return 69; }
    runtime.trace_initialized=1;
    if(check) {
        char line[256];int n=snprintf(line,sizeof(line),"{\"type\":\"checked\",\"pid\":%u,\"starttime\":\"%llu\",\"profile\":\"%s\",\"backend\":\"perf-scalar\",\"initialBytes\":%u,\"maxFrame\":%u}\n",
            runtime.target.pid,U(runtime.target.starttime),AA_PROFILE,AA_INITIAL_BYTES,AA_MAX_FRAME);
        return write(STDOUT_FILENO,line,(size_t)n)==n ? 0 : 74;
    }
    struct sigaction action={0};action.sa_handler=stop_signal;sigemptyset(&action.sa_mask);
    sigaction(SIGINT,&action,NULL);sigaction(SIGTERM,&action,NULL);sigaction(SIGHUP,&action,NULL);signal(SIGPIPE,SIG_IGN);
    atexit(cleanup);runtime.writing=-1;
    int input_flags=fcntl(STDIN_FILENO,F_GETFL),output_flags=fcntl(STDOUT_FILENO,F_GETFL);
    if(input_flags<0||output_flags<0||fcntl(STDIN_FILENO,F_SETFL,input_flags|O_NONBLOCK)||fcntl(STDOUT_FILENO,F_SETFL,output_flags|O_NONBLOCK)) {
        aa_log("error","pipe-configuration",errno);return 74;
    }
    aa_control_init(&runtime.control,(uint32_t)lease_ms,aa_now());
    while(!runtime.control.seen) {
        if(pulse(&runtime)) { aa_log("closed",runtime.stop_reason,0);return 0; }
        if(!runtime.control.seen) { struct pollfd p={STDIN_FILENO,POLLIN|POLLHUP,0};(void)poll(&p,1,20); }
    }
    aa_stream_init(&runtime.stream,runtime.target.pid,(uint32_t)initial);
    if(aa_trace_open(&runtime.trace,&runtime.target,runtime.stream.windows,(uint32_t)lease_ms,pulse,&runtime)) {
        aa_log(runtime.stop_reason ? "closed" : "error",runtime.stop_reason ? runtime.stop_reason : "capture-prepare",errno);return runtime.stop_reason ? 0 : 69;
    }
    if(pulse(&runtime)||aa_target_current(&runtime.target)||aa_trace_enable(&runtime.trace)) {
        aa_log("error",runtime.stop_reason ? runtime.stop_reason : "target-changed-before-arm",errno);return 69;
    }
    uint64_t now=aa_now(),report_due=now+1000000000ULL;
    if(max_seconds) runtime.stop_time=now+max_seconds*1000000000ULL;
    char armed[320];int n=snprintf(armed,sizeof(armed),"{\"type\":\"armed\",\"pid\":%u,\"starttime\":\"%llu\",\"profile\":\"%s\",\"windows\":%u,\"capacity\":%u,\"maxFrame\":%u,\"leaseMs\":%u}\n",
        runtime.target.pid,U(runtime.target.starttime),AA_PROFILE,runtime.stream.windows,runtime.stream.capacity,AA_MAX_FRAME,(unsigned)lease_ms);
    (void)write(STDERR_FILENO,armed,(size_t)n);int status=0;
    while(!pulse(&runtime)) {
        now=aa_now();
        if(now>=runtime.identity_due) {
            if(aa_target_current(&runtime.target)) { runtime.stop_reason="target-changed";status=65;break; }
            runtime.identity_due=now+1000000000ULL;
        }
        int drained=aa_trace_drain(&runtime.trace,&runtime.stream,pulse,&runtime);
        if(runtime.stream.error) { recovery(&runtime.stream);status=75;break; }
        if(drained<0) break;
        if(output_step(&runtime,aa_now())) {
            if(runtime.stream.error) { recovery(&runtime.stream);status=75; }
            else status=74;
            break;
        }
        if(now>=report_due) { report_stats(&runtime);report_due=now+1000000000ULL; }
        struct pollfd fds[AA_MAX_CPUS+2];nfds_t count=0;
        fds[count++]=(struct pollfd){STDIN_FILENO,POLLIN|POLLHUP,0};
        for(int cpu=0;cpu<runtime.trace.cpus;cpu++) if(runtime.trace.cpu[cpu].fd[0]>=0)
            fds[count++]=(struct pollfd){runtime.trace.cpu[cpu].fd[0],POLLIN,0};
        if(runtime.writing>=0) fds[count++]=(struct pollfd){STDOUT_FILENO,POLLOUT,0};
        if(poll(fds,count,drained>0 ? 0 : 5)<0 && errno!=EINTR) { runtime.stop_reason="poll-error";status=74;break; }
    }
    aa_trace_close(&runtime.trace);runtime.trace_initialized=0;report_stats(&runtime);
    aa_log("closed",runtime.stop_reason ? runtime.stop_reason : (status==75 ? "recovery-required" : "complete"),0);
    return status;
}
