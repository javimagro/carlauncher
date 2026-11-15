/* SPDX-License-Identifier: MIT */
#include "aa-capture.h"
#include <string.h>
static uint32_t u32(const unsigned char *p) { uint32_t n; memcpy(&n,p,4); return n; }
static uint64_t u64(const unsigned char *p) { uint64_t n; memcpy(&n,p,8); return n; }
static int fail(struct aa_stream *s,enum aa_stream_error error) {
    if(!s->error) s->error=error;
    return -1;
}
void aa_stream_init(struct aa_stream *s,uint32_t pid,uint32_t capacity) {
    memset(s,0,sizeof(*s)); s->pid=pid;
    if(capacity<1 || capacity>AA_MAX_FRAME) { s->error=AA_FRAME_TOO_LARGE; return; }
    s->windows=(capacity+AA_WINDOW-1)/AA_WINDOW;
    s->capacity=s->windows*AA_WINDOW;
    if(s->capacity>AA_MAX_FRAME) s->capacity=AA_MAX_FRAME;
}
static struct aa_slot *get_slot(struct aa_stream *s,uint32_t tid,uint64_t pointer,uint64_t stamp,
                               uint64_t flags,uint32_t size,uint64_t time) {
    struct aa_slot *free_slot=NULL;
    for(unsigned i=0;i<AA_SLOTS;i++) {
        struct aa_slot *a=&s->slots[i];
        if(!a->state) { if(!free_slot) free_slot=a; continue; }
        if(a->state==1 && a->header.tid==tid && a->pointer==pointer &&
           a->header.timestamp==stamp && a->header.flags==flags && a->header.total_size==size) {
            uint64_t first=a->header.frame_id;
            if((time>first && time-first>AA_ASSEMBLY_NS) || (first>time && first-time>AA_ASSEMBLY_NS)) {
                s->counts.incomplete++; fail(s,AA_INCOMPLETE); return NULL;
            }
            return a;
        }
    }
    if(!free_slot) { fail(s,AA_QUEUE_FULL); return NULL; }
    memset(&free_slot->header,0,sizeof(free_slot->header));
    memset(free_slot->mask,0,sizeof(free_slot->mask));
    free_slot->state=1; free_slot->parts=0; free_slot->pointer=pointer; free_slot->last_time=time;
    struct aa_header *h=&free_slot->header;
    h->magic=AA_MAGIC; h->header_size=64; h->frame_id=time; h->timestamp=stamp; h->flags=flags;
    h->total_size=size; h->chunk_size=size; h->tgid=s->pid; h->tid=tid;
    unsigned active=0; for(unsigned i=0;i<AA_SLOTS;i++) if(s->slots[i].state) active++;
    if(active>s->counts.queue_high) s->counts.queue_high=active;
    return free_slot;
}
int aa_stream_sample(struct aa_stream *s,uint32_t window,uint32_t cpu,const void *record,size_t size,uint64_t now) {
    if(s->error) return -1;
    const unsigned char *p=record;
    /* Linux perf SAMPLE: header8,TID8,TIME8,RAW size4,data. The verified BMW
     * trace_entry adds common_tgid@8; metadata ends at RAW+60. */
    if(size<28+60+AA_WINDOW || window>=s->windows || cpu>=AA_MAX_CPUS ||
       u32(p+24)<60+AA_WINDOW || u32(p+24)>size-28) {
        s->counts.malformed++; return fail(s,AA_BAD_RECORD);
    }
    const unsigned char *raw=p+28;
    if(u32(p+8)!=s->pid || u32(raw+8)!=s->pid || u32(raw+56)!=0) {
        s->counts.malformed++; return fail(s,AA_BAD_RECORD);
    }
    uint64_t length=u64(raw+32),time=u64(p+16);
    s->counts.samples++;
    if(length>s->counts.max_length) s->counts.max_length=length;
    if(length>s->capacity) {
        s->counts.oversized++;
        s->required_bytes=length>UINT32_MAX ? UINT32_MAX : (uint32_t)length;
        return fail(s,AA_FRAME_TOO_LARGE);
    }
    uint32_t offset=window*AA_WINDOW;
    if(!length || offset>=length || !time) { s->counts.malformed++; return fail(s,AA_BAD_RECORD); }
    if(time<=s->last_emitted) { s->counts.late++; return fail(s,AA_LATE); }
    if(now>=time && now-time>s->counts.max_lag_ns) s->counts.max_lag_ns=now-time;
    struct aa_slot *a=get_slot(s,u32(p+12),u64(raw+24),u64(raw+40),u64(raw+48),(uint32_t)length,time);
    if(!a) return -1;
    uint64_t bit=1ULL<<(window%64);
    if(a->mask[window/64]&bit) { s->counts.incomplete++; return fail(s,AA_DUPLICATE); }
    uint32_t count=(uint32_t)length-offset; if(count>AA_WINDOW) count=AA_WINDOW;
    memcpy(a->payload+offset,raw+60,count);
    a->mask[window/64]|=bit; a->parts++;
    if(time<a->header.frame_id) a->header.frame_id=time;
    if(time>a->last_time) a->last_time=time;
    if(window==0) a->header.cpu=cpu;
    if(a->parts==((uint32_t)length+AA_WINDOW-1)/AA_WINDOW) {
        a->state=2; s->counts.complete++;
        uint64_t span=a->last_time-a->header.frame_id;
        if(span>s->counts.max_span_ns) s->counts.max_span_ns=span;
    }
    return 0;
}
int aa_stream_next(struct aa_stream *s,uint64_t now) {
    if(s->error) return -1;
    int first=-1;
    for(unsigned i=0;i<AA_SLOTS;i++) {
        struct aa_slot *a=&s->slots[i];
        if(a->state==1 && now>a->header.frame_id && now-a->header.frame_id>AA_ASSEMBLY_NS) {
            s->counts.incomplete++; fail(s,AA_INCOMPLETE); return -1;
        }
        if(a->state && a->state!=3 && (first<0 || a->header.frame_id<s->slots[first].header.frame_id)) first=(int)i;
    }
    if(first<0) return -1;
    struct aa_slot *a=&s->slots[first];
    if(a->state!=2 || now<a->header.frame_id || now-a->header.frame_id<AA_REORDER_NS) return -1;
    if(a->header.frame_id<=s->last_emitted) { s->counts.late++; fail(s,AA_LATE); return -1; }
    a->state=3; return first;
}
void aa_stream_done(struct aa_stream *s,unsigned slot) {
    if(slot>=AA_SLOTS || s->slots[slot].state!=3) { fail(s,AA_BAD_RECORD); return; }
    struct aa_slot *a=&s->slots[slot];
    s->last_emitted=a->header.frame_id; s->counts.emitted++; s->counts.payload_bytes+=a->header.total_size;
    a->state=0;
}
void aa_stream_lost(struct aa_stream *s,uint64_t count) { s->counts.lost+=count; fail(s,AA_LOST); }
const char *aa_stream_reason(enum aa_stream_error e) {
    static const char *const names[]={"ok","malformed-record","frame-too-large","perf-loss","incomplete-frame",
        "capture-queue-full","late-frame","duplicate-window"};
    return (unsigned)e<sizeof(names)/sizeof(names[0]) ? names[e] : "unknown";
}
