/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "aa-platform.h"
#include <errno.h>
#include <fcntl.h>
#include <linux/perf_event.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/resource.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#define RING_PAGES 128U
static unsigned char record[65536];
int aa_trace_available(struct aa_trace *trace) {
    memset(trace,0,sizeof(*trace));trace->events_fd=trace->lock_fd=trace->guard_fd=-1;
    for(unsigned c=0;c<AA_MAX_CPUS;c++) for(unsigned w=0;w<AA_MAX_WINDOWS;w++) trace->cpu[c].fd[w]=-1;
    const char *roots[]={"/sys/kernel/tracing","/sys/kernel/debug/tracing"};
    for(unsigned i=0;i<2;i++) {
        char path[128];snprintf(path,sizeof(path),"%s/uprobe_events",roots[i]);
        if(access(path,R_OK|W_OK)==0) { snprintf(trace->root,sizeof(trace->root),"%s",roots[i]);break; }
    }
    if(!trace->root[0]) { errno=ENOTSUP;return -1; }
    FILE *f=fopen("/sys/devices/system/cpu/possible","r");if(!f) return -1;
    char cpu[128];char *p=fgets(cpu,sizeof(cpu),f);fclose(f);if(!p) return -1;
    unsigned last=0;int consumed=0;
    if(sscanf(cpu,"0-%u%n",&last,&consumed)==1 && (cpu[consumed]=='\n'||!cpu[consumed]) && last<AA_MAX_CPUS) trace->cpus=(int)last+1;
    else if(!strcmp(cpu,"0\n")||!strcmp(cpu,"0")) trace->cpus=1;
    else { errno=ENOTSUP;return -1; }
    return 0;
}
static int check_format(struct aa_trace *trace,unsigned window) {
    static const struct { const char *name;unsigned offset,size; } fields[]={
        {"common_type",0,2},{"common_tgid",8,4},{"buf",24,8},{"len",32,8},{"ts",40,8},
        {"flags",48,8},{"display",56,4},{"w0",60,8},{"w119",1012,8}};
    char path[192],line[1024];snprintf(path,sizeof(path),"%s/events/%s/v%03u/format",trace->root,trace->group,window);
    FILE *f=fopen(path,"r");if(!f) return -1;unsigned mask=0;
    while(fgets(line,sizeof(line),f)) {
        char *field=strstr(line,"field:"),*offset=strstr(line,"offset:"),*size=strstr(line,"size:");
        if(!field||!offset||!size) continue;
        char *end=strchr(field,';');if(!end) continue;*end=0;char *name=strrchr(field,' ');if(!name) continue;name++;
        unsigned actual_offset,actual_size;
        if(sscanf(offset,"offset:%u",&actual_offset)!=1 || sscanf(size,"size:%u",&actual_size)!=1) continue;
        for(unsigned i=0;i<sizeof(fields)/sizeof(fields[0]);i++) if(!strcmp(name,fields[i].name)) {
            if(actual_offset!=fields[i].offset || actual_size!=fields[i].size) { fclose(f);errno=ENOTSUP;return -1; }
            mask|=1U<<i;
        }
    }
    fclose(f);if(mask!=((1U<<(sizeof(fields)/sizeof(fields[0])))-1)) { errno=ENOTSUP;return -1; }
    snprintf(path,sizeof(path),"%s/events/%s/v%03u/id",trace->root,trace->group,window);
    f=fopen(path,"r");if(!f) return -1;unsigned id=0;int parsed=fscanf(f,"%u",&id);fclose(f);
    if(parsed!=1||!id||id>65535) { errno=ENOTSUP;return -1; }
    trace->ids[window]=id;return 0;
}
static int register_window(struct aa_trace *trace,unsigned window) {
    char command[8192];size_t used=(size_t)snprintf(command,sizeof(command),
        "p:%s/v%03u " AA_LIBRARY ":0x%x buf=%%si:u64 len=%%dx:u64 ts=%%cx:u64 flags=%%r8:u64 display=+28(%%di):u32",trace->group,window,AA_OFFSET);
    for(unsigned word=0;word<120;word++) {
        int n=snprintf(command+used,sizeof(command)-used," w%u=+%u(%%si):x64",word,window*AA_WINDOW+word*8);
        if(n<0 || (size_t)n>=sizeof(command)-used) { errno=EOVERFLOW;return -1; }used+=(size_t)n;
    }
    command[used++]='\n';if(write(trace->events_fd,command,used)!=(ssize_t)used) return -1;
    trace->created=window+1;return check_format(trace,window);
}
int aa_trace_open(struct aa_trace *trace,const struct aa_target *target,uint32_t windows,uint32_t lease_ms,aa_pulse_fn pulse,void *context) {
    if(aa_owner_open(trace,windows,lease_ms)) return -1;
    char path[128];snprintf(path,sizeof(path),"%s/uprobe_events",trace->root);
    trace->events_fd=open(path,O_WRONLY|O_APPEND|O_CLOEXEC);if(trace->events_fd<0) return -1;
    struct rlimit limit;if(getrlimit(RLIMIT_NOFILE,&limit)) return -1;
    rlim_t needed=(rlim_t)windows*(unsigned)trace->cpus+64;
    if(limit.rlim_cur<needed) { limit.rlim_cur=needed;if(limit.rlim_max<needed) limit.rlim_max=needed;if(setrlimit(RLIMIT_NOFILE,&limit)) return -1; }
    for(unsigned w=0;w<windows;w++) { if(pulse(context)||register_window(trace,w)) return -1; }
    long page=sysconf(_SC_PAGESIZE);if(page<1) return -1;
    unsigned capacity=windows*AA_WINDOW;if(capacity>AA_MAX_FRAME) capacity=AA_MAX_FRAME;
    unsigned attached=0;
    for(int cpu=0;cpu<trace->cpus;cpu++) {
        struct aa_channel *c=&trace->cpu[cpu];
        for(unsigned w=0;w<windows;w++) {
            if(pulse(context)) return -1;
            struct perf_event_attr a={0};a.size=PERF_ATTR_SIZE_VER3;a.type=PERF_TYPE_TRACEPOINT;a.config=trace->ids[w];
            a.sample_type=PERF_SAMPLE_TID|PERF_SAMPLE_TIME|PERF_SAMPLE_RAW;a.sample_period=1;a.wakeup_events=1;
            a.disabled=1;a.use_clockid=1;a.clockid=CLOCK_MONOTONIC;
            c->fd[w]=(int)syscall(SYS_perf_event_open,&a,-1,cpu,-1,PERF_FLAG_FD_CLOEXEC);
            if(w==0 && c->fd[w]<0 && errno==ENODEV) break;
            if(c->fd[w]<0) return -1;
            char filter[160];
            if(w==0) snprintf(filter,sizeof(filter),"common_tgid == %u && display == 0",target->pid);
            else snprintf(filter,sizeof(filter),"common_tgid == %u && display == 0 && len > %u && len <= %u",target->pid,w*AA_WINDOW,capacity);
            if(ioctl(c->fd[w],PERF_EVENT_IOC_SET_FILTER,filter)) return -1;
            if(w==0) {
                c->size=(size_t)page*RING_PAGES;c->mapping_size=c->size+(size_t)page;
                c->mapping=mmap(NULL,c->mapping_size,PROT_READ|PROT_WRITE,MAP_SHARED,c->fd[0],0);
                if(c->mapping==MAP_FAILED) return -1;c->ring=(unsigned char *)c->mapping+page;
            } else if(ioctl(c->fd[w],PERF_EVENT_IOC_SET_OUTPUT,c->fd[0])) return -1;
        }
        if(c->fd[0]>=0) attached++;
    }
    if(!attached) { errno=ENODEV;return -1; }return 0;
}
int aa_trace_enable(struct aa_trace *trace) {
    for(int cpu=0;cpu<trace->cpus;cpu++) if(trace->cpu[cpu].fd[0]>=0)
        for(unsigned w=trace->windows;w>0;w--) if(ioctl(trace->cpu[cpu].fd[w-1],PERF_EVENT_IOC_ENABLE,0)) return -1;
    return 0;
}
static void ring_copy(const struct aa_channel *c,uint64_t position,void *dest,size_t size) {
    size_t offset=(size_t)(position&(c->size-1)),first=c->size-offset;if(first>size) first=size;
    memcpy(dest,c->ring+offset,first);if(size>first) memcpy((unsigned char *)dest+first,c->ring,size-first);
}
int aa_trace_drain(struct aa_trace *trace,struct aa_stream *stream,aa_pulse_fn pulse,void *context) {
    unsigned total=0;int progress;
    do {
        progress=0;
        for(int cpu=0;cpu<trace->cpus;cpu++) {
            struct aa_channel *c=&trace->cpu[cpu];if(c->fd[0]<0) continue;
            struct perf_event_mmap_page *meta=c->mapping;
            uint64_t head=__atomic_load_n(&meta->data_head,__ATOMIC_ACQUIRE);
            if(head<c->tail || head-c->tail>c->size) { aa_stream_lost(stream,1);return -1; }
            for(unsigned batch=0;batch<8 && c->tail<head;batch++) {
                struct perf_event_header h;
                if(head-c->tail<sizeof(h)) { aa_stream_lost(stream,1);return -1; }
                ring_copy(c,c->tail,&h,sizeof(h));
                if(h.size<sizeof(h)||h.size>head-c->tail) { aa_stream_lost(stream,1);return -1; }
                ring_copy(c,c->tail,record,h.size);c->tail+=h.size;total++;progress=1;
                if(h.type==PERF_RECORD_SAMPLE) {
                    uint16_t id=0;if(h.size>=30) memcpy(&id,record+28,2);
                    unsigned window=0;while(window<trace->windows && trace->ids[window]!=id) window++;
                    if(aa_stream_sample(stream,window,(uint32_t)cpu,record,h.size,aa_now())) return -1;
                } else if(h.type==PERF_RECORD_LOST) {
                    uint64_t lost=1;if(h.size>=24) memcpy(&lost,record+16,8);aa_stream_lost(stream,lost);return -1;
                }
            }
            __atomic_store_n(&meta->data_tail,c->tail,__ATOMIC_RELEASE);
        }
        if(pulse(context)) return -1;
    } while(progress && total<256);
    return (int)total;
}
void aa_trace_close(struct aa_trace *trace) {
    for(unsigned cpu=0;cpu<AA_MAX_CPUS;cpu++) {
        struct aa_channel *c=&trace->cpu[cpu];
        for(unsigned w=0;w<AA_MAX_WINDOWS;w++) if(c->fd[w]>=0) {
            (void)ioctl(c->fd[w],PERF_EVENT_IOC_DISABLE,0);close(c->fd[w]);c->fd[w]=-1;
        }
        if(c->mapping && c->mapping!=MAP_FAILED) { munmap(c->mapping,c->mapping_size);c->mapping=NULL; }
    }
    if(trace->created && aa_remove_events(trace->root,trace->group,trace->created)) aa_log("error","cleanup-pending",errno);
    trace->created=0;
    if(trace->events_fd>=0) { close(trace->events_fd);trace->events_fd=-1; }
    aa_owner_close(trace);
}
