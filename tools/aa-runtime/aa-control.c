/* SPDX-License-Identifier: MIT */
#include "aa-capture.h"
#include <string.h>
void aa_control_init(struct aa_control *c,uint32_t lease_ms,uint64_t now) {
    memset(c,0,sizeof(*c));c->lease_ms=lease_ms;c->deadline=now+(uint64_t)lease_ms*1000000;
}
int aa_control_feed(struct aa_control *c,const void *buffer,size_t size,uint64_t now) {
    if(!aa_control_alive(c,now)) return -1;
    const unsigned char *p=buffer;
    for(size_t i=0;i<size;i++) {
        if(c->stopped || c->error) return -1;
        if(p[i]=='\n') {
            c->line[c->used]=0;
            if(!strcmp(c->line,"lease")) { c->seen=1;c->deadline=now+(uint64_t)c->lease_ms*1000000; }
            else if(!strcmp(c->line,"stop")) c->stopped=1;
            else c->error=1;
            c->used=0;
        } else if(c->used>=sizeof(c->line)-1 || p[i]<32 || p[i]>126) c->error=1;
        else c->line[c->used++]=(char)p[i];
    }
    return c->error ? -1 : 0;
}
int aa_control_alive(const struct aa_control *c,uint64_t now) { return !c->stopped && !c->error && now<c->deadline; }
