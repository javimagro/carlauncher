/* SPDX-License-Identifier: MIT */
#ifndef BMW_AA_CAPTURE_H
#define BMW_AA_CAPTURE_H
#include <stddef.h>
#include <stdint.h>
#define AA_PROFILE "mgu21-aa-20261115"
#define AA_LIBRARY "/usr/lib/cinemo/libNmeAndroidAuto.so"
#define AA_LIBRARY_SHA "10446b6de0d99272cc28d0e51e9afa0e2bbcbb40eef6c7ad688f1544857ef1ac"
#define AA_EXE_SHA "a7971d64fc0feb4e48942441dc76a67d6df282b56cb5d64e92248ff83f18d62e"
#define AA_OFFSET 0x960b0U
#define AA_MAX_FRAME 262144U
#define AA_WINDOW 960U
#define AA_MAX_WINDOWS ((AA_MAX_FRAME+AA_WINDOW-1)/AA_WINDOW)
#define AA_INITIAL_BYTES 61440U
#define AA_MAX_CPUS 16U
#define AA_SLOTS 12U
#define AA_REORDER_NS 10000000ULL
#define AA_ASSEMBLY_NS 100000000ULL
#define AA_MAGIC 0x31464141U
struct aa_header {
    uint32_t magic,header_size;
    uint64_t frame_id,timestamp,flags;
    uint32_t total_size,chunk_size,offset,cpu,tgid,tid,display,reserved;
};
_Static_assert(sizeof(struct aa_header)==64,"AAF1 header ABI");
struct aa_slot {
    struct aa_header header;
    uint64_t pointer,last_time,mask[(AA_MAX_WINDOWS+63)/64];
    uint32_t parts,state;
    unsigned char payload[AA_MAX_FRAME];
};
struct aa_counts {
    uint64_t samples,complete,emitted,payload_bytes,max_length,max_lag_ns,max_span_ns;
    uint64_t lost,malformed,incomplete,oversized,late,queue_high;
};
enum aa_stream_error { AA_STREAM_OK,AA_BAD_RECORD,AA_FRAME_TOO_LARGE,AA_LOST,
    AA_INCOMPLETE,AA_QUEUE_FULL,AA_LATE,AA_DUPLICATE };
struct aa_stream {
    struct aa_slot slots[AA_SLOTS];
    struct aa_counts counts;
    uint32_t pid,windows,capacity,required_bytes;
    enum aa_stream_error error;
    uint64_t last_emitted;
};
void aa_stream_init(struct aa_stream *s,uint32_t pid,uint32_t capacity);
int aa_stream_sample(struct aa_stream *s,uint32_t window,uint32_t cpu,const void *record,size_t size,uint64_t now);
int aa_stream_next(struct aa_stream *s,uint64_t now);
void aa_stream_done(struct aa_stream *s,unsigned slot);
void aa_stream_lost(struct aa_stream *s,uint64_t count);
const char *aa_stream_reason(enum aa_stream_error error);

struct aa_sha256 { uint32_t h[8]; uint64_t bytes; unsigned char block[64]; size_t used; };
void aa_sha256_init(struct aa_sha256 *s);
void aa_sha256_update(struct aa_sha256 *s,const void *data,size_t size);
void aa_sha256_final(struct aa_sha256 *s,unsigned char digest[32]);
void aa_sha256_hex(const unsigned char digest[32],char out[65]);
struct aa_control { uint64_t deadline; uint32_t lease_ms; unsigned used,seen; int stopped,error; char line[16]; };
void aa_control_init(struct aa_control *c,uint32_t lease_ms,uint64_t now);
int aa_control_feed(struct aa_control *c,const void *data,size_t size,uint64_t now);
int aa_control_alive(const struct aa_control *c,uint64_t now);
#endif
