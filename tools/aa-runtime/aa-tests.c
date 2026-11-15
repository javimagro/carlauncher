/* SPDX-License-Identifier: MIT */
#include "aa-capture.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static unsigned checks,failures;
#define CHECK(x) do { checks++;if(!(x)) { fprintf(stderr,"check failed line %u: %s\n",(unsigned)__LINE__,#x);failures++; } } while(0)
static void put32(unsigned char *p,uint32_t n) { memcpy(p,&n,4); }
static void put64(unsigned char *p,uint64_t n) { memcpy(p,&n,8); }
static void sample(unsigned char *p,unsigned window,uint32_t length,uint64_t stamp,uint64_t time) {
    memset(p,0,28+60+AA_WINDOW);put32(p+8,123);put32(p+12,124);put64(p+16,time);put32(p+24,60+AA_WINDOW);
    unsigned char *raw=p+28;put32(raw+8,123);put64(raw+24,0x1000);put64(raw+32,length);put64(raw+40,stamp);put64(raw+48,32);
    for(unsigned i=0;i<AA_WINDOW;i++) raw[60+i]=(unsigned char)((window*AA_WINDOW+i)%251);
}
static void hashes(void) {
    static const struct {const char *text,*hash;} vectors[]={
        {"","e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"},
        {"abc","ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},
        {"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq","248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"}};
    for(unsigned i=0;i<sizeof(vectors)/sizeof(vectors[0]);i++) {
        struct aa_sha256 s;unsigned char digest[32];char result[65];aa_sha256_init(&s);
        for(size_t n=0;n<strlen(vectors[i].text);n++) aa_sha256_update(&s,vectors[i].text+n,1);
        aa_sha256_final(&s,digest);aa_sha256_hex(digest,result);CHECK(!strcmp(result,vectors[i].hash));
    }
    struct aa_sha256 s;unsigned char block[1000],digest[32];char result[65];memset(block,'a',sizeof(block));aa_sha256_init(&s);
    for(unsigned i=0;i<1000;i++) aa_sha256_update(&s,block,sizeof(block));
    aa_sha256_final(&s,digest);aa_sha256_hex(digest,result);
    CHECK(!strcmp(result,"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"));
}
static void controls(void) {
    struct aa_control c;aa_control_init(&c,1000,100);
    CHECK(aa_control_feed(&c,"lea",3,200)==0);CHECK(!c.seen);
    CHECK(aa_control_feed(&c,"se\n",3,300)==0);CHECK(c.seen);CHECK(c.deadline==1000000300ULL);
    CHECK(aa_control_alive(&c,c.deadline-1));CHECK(!aa_control_alive(&c,c.deadline));
    uint64_t deadline=c.deadline;CHECK(aa_control_feed(&c,"lease\n",6,deadline)==-1);CHECK(c.deadline==deadline);
    aa_control_init(&c,1000,0);CHECK(aa_control_feed(&c,"stop\n",5,1)==0);CHECK(!aa_control_alive(&c,2));
    aa_control_init(&c,1000,0);CHECK(aa_control_feed(&c,"unrecognised\n",13,1)==-1);CHECK(c.error);
    aa_control_init(&c,1000,0);CHECK(aa_control_feed(&c,"012345678901234567890",21,1)==-1);
}
static void streams(void) {
    struct aa_stream *s=calloc(1,sizeof(*s));CHECK(s!=NULL);if(!s) return;
    unsigned char p[28+60+AA_WINDOW];const uint64_t t=1000000000ULL;
    aa_stream_init(s,123,AA_MAX_FRAME);CHECK(s->windows==274);CHECK(s->capacity==AA_MAX_FRAME);
    /* Full 256 KiB, reverse window arrival and exact final-window trimming. */
    for(unsigned w=s->windows;w>0;w--) { sample(p,w-1,AA_MAX_FRAME,42,t+w);CHECK(!aa_stream_sample(s,w-1,3,p,sizeof(p),t+1000)); }
    CHECK(s->counts.complete==1);CHECK(aa_stream_next(s,t+AA_REORDER_NS-1)==-1);
    int slot=aa_stream_next(s,t+AA_REORDER_NS+1000);CHECK(slot>=0);
    if(slot>=0) {
        struct aa_slot *a=&s->slots[slot];CHECK(a->header.total_size==AA_MAX_FRAME);CHECK(a->header.cpu==3);
        int valid=1;for(unsigned i=0;i<AA_MAX_FRAME;i++) if(a->payload[i]!=(unsigned char)(i%251)) valid=0;
        CHECK(valid);aa_stream_done(s,(unsigned)slot);CHECK(s->counts.emitted==1);
    }
    /* Cross-CPU completion order: newer frame arrives first. */
    aa_stream_init(s,123,AA_INITIAL_BYTES);sample(p,0,20,2,t+2000);CHECK(!aa_stream_sample(s,0,1,p,sizeof(p),t+3000));
    sample(p,0,20,1,t+1000);CHECK(!aa_stream_sample(s,0,0,p,sizeof(p),t+4000));
    slot=aa_stream_next(s,t+AA_REORDER_NS+5000);CHECK(slot>=0);
    if(slot>=0) { CHECK(s->slots[slot].header.timestamp==1);aa_stream_done(s,(unsigned)slot); }
    slot=aa_stream_next(s,t+AA_REORDER_NS+5000);CHECK(slot>=0);
    if(slot>=0) { CHECK(s->slots[slot].header.timestamp==2);aa_stream_done(s,(unsigned)slot); }
    sample(p,0,20,0,t);CHECK(aa_stream_sample(s,0,0,p,sizeof(p),t+4000)==-1);CHECK(s->error==AA_LATE);
    /* An older incomplete frame prevents publishing a newer complete frame. */
    aa_stream_init(s,123,AA_INITIAL_BYTES);sample(p,0,1000,1,t);CHECK(!aa_stream_sample(s,0,0,p,sizeof(p),t));
    sample(p,0,20,2,t+2000);CHECK(!aa_stream_sample(s,0,1,p,sizeof(p),t+2000));
    CHECK(aa_stream_next(s,t+AA_REORDER_NS+5000)==-1);CHECK(s->error==AA_STREAM_OK);
    CHECK(aa_stream_next(s,t+AA_ASSEMBLY_NS+1)==-1);CHECK(s->error==AA_INCOMPLETE);
    aa_stream_init(s,123,AA_INITIAL_BYTES);sample(p,0,61665,1,t);
    CHECK(aa_stream_sample(s,0,0,p,sizeof(p),t)==-1);CHECK(s->error==AA_FRAME_TOO_LARGE);CHECK(s->required_bytes==61665);
    aa_stream_init(s,123,AA_INITIAL_BYTES);sample(p,0,20,1,t);put32(p+28+56,1);
    CHECK(aa_stream_sample(s,0,0,p,sizeof(p),t)==-1);CHECK(s->error==AA_BAD_RECORD);
    aa_stream_init(s,123,AA_INITIAL_BYTES);sample(p,0,20,1,t);put32(p+8,999);
    CHECK(aa_stream_sample(s,0,0,p,sizeof(p),t)==-1);CHECK(s->error==AA_BAD_RECORD);
    aa_stream_init(s,123,AA_INITIAL_BYTES);sample(p,0,1000,1,t);CHECK(!aa_stream_sample(s,0,0,p,sizeof(p),t));
    CHECK(aa_stream_sample(s,0,0,p,sizeof(p),t)==-1);CHECK(s->error==AA_DUPLICATE);
    aa_stream_init(s,123,AA_INITIAL_BYTES);aa_stream_lost(s,5);CHECK(s->error==AA_LOST);CHECK(s->counts.lost==5);
    aa_stream_init(s,123,AA_INITIAL_BYTES);
    for(unsigned i=0;i<AA_SLOTS;i++) { sample(p,0,20,i,t+i);CHECK(!aa_stream_sample(s,0,0,p,sizeof(p),t)); }
    sample(p,0,20,99,t+99);CHECK(aa_stream_sample(s,0,0,p,sizeof(p),t)==-1);CHECK(s->error==AA_QUEUE_FULL);
    free(s);
}
int aa_self_test(void) {
    checks=failures=0;hashes();controls();streams();
    fprintf(stderr,"{\"type\":\"self-test\",\"checks\":%u,\"failures\":%u}\n",checks,failures);
    return failures ? 1 : 0;
}
#ifdef AA_TEST_MAIN
int main(void) { return aa_self_test(); }
#endif
