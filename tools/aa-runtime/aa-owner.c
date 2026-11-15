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
#include <sys/file.h>
#include <sys/prctl.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#define LOCK_PATH "/run/bmwlauncher-aa-capture.lock"
static void group_name(char *out,size_t size,uint32_t pid,uint64_t start,unsigned nonce) {
    snprintf(out,size,"bmwl_aa_%u_%llx_%08x",pid,(unsigned long long)start,nonce);
}
int aa_remove_events(const char *root,const char *group,uint32_t windows) {
    char path[128],line[128];snprintf(path,sizeof(path),"%s/uprobe_events",root);
    int fd=open(path,O_WRONLY|O_APPEND|O_CLOEXEC);if(fd<0) return -1;int failed=0;
    for(uint32_t n=windows;n>0;n--) {
        int length=snprintf(line,sizeof(line),"-:%s/v%03u\n",group,n-1);
        if(write(fd,line,(size_t)length)!=length && errno!=ENOENT) failed=1;
    }
    close(fd);return failed ? -1 : 0;
}
static int still_process(pid_t pid,uint64_t start) {
    uint64_t current;return aa_starttime((uint32_t)pid,&current)==0 && current==start;
}
static void guard_loop(struct aa_trace *trace,int input,pid_t owner,uint64_t owner_start,uint32_t lease_ms) {
    close(STDIN_FILENO);close(STDOUT_FILENO);
    (void)prctl(PR_SET_NAME,"aa-cap-guard",0,0,0);
    signal(SIGPIPE,SIG_IGN);
    uint64_t limit=aa_now()+((uint64_t)lease_ms+500)*1000000;
    int expired=0;
    for(;;) {
        struct pollfd p={input,POLLIN|POLLHUP,0};int status=poll(&p,1,100);
        if(status<0 && errno!=EINTR) break;
        if(status>0) {
            unsigned char bytes[256];ssize_t n=read(input,bytes,sizeof(bytes));
            if(n==0) break;
            if(n>0) limit=aa_now()+((uint64_t)lease_ms+500)*1000000;
            else if(errno!=EINTR && errno!=EAGAIN) break;
        }
        if(aa_now()>=limit) { expired=1;break; }
    }
    /* Signals only the helper PID created by this session, never aapd. */
    if(expired && still_process(owner,owner_start)) {
        (void)kill(owner,SIGTERM);struct timespec pause={0,100000000};nanosleep(&pause,NULL);
        if(still_process(owner,owner_start)) (void)kill(owner,SIGKILL);
    }
    uint64_t end=aa_now()+2000000000ULL;
    while(expired && still_process(owner,owner_start) && aa_now()<end) {
        struct timespec pause={0,20000000};nanosleep(&pause,NULL);
    }
    if(aa_remove_events(trace->root,trace->group,trace->windows)) aa_log("error","guardian-cleanup-pending",errno);
    else if(expired) aa_log("closed","guardian-expired",0);
    close(input);close(trace->lock_fd);_exit(0);
}
int aa_owner_open(struct aa_trace *trace,uint32_t windows,uint32_t lease_ms) {
    trace->lock_fd=open(LOCK_PATH,O_RDWR|O_CREAT|O_CLOEXEC|O_NOFOLLOW,0600);
    if(trace->lock_fd<0) return -1;
    struct stat st;if(fstat(trace->lock_fd,&st) || !S_ISREG(st.st_mode) || st.st_uid!=geteuid() || st.st_nlink!=1 || (st.st_mode&0777)!=0600) { errno=EPERM;return -1; }
    if(flock(trace->lock_fd,LOCK_EX|LOCK_NB)) return -1;
    char previous[128]={0};ssize_t size=pread(trace->lock_fd,previous,sizeof(previous)-1,0);
    if(size<0) return -1;
    if(size>0) {
        unsigned version,owner,nonce,count;unsigned long long start;char tail;
        if(sscanf(previous,"%u %u %llu %x %u %c",&version,&owner,&start,&nonce,&count,&tail)!=5 ||
           version!=1 || !owner || owner>INT32_MAX || !start || !count || count>AA_MAX_WINDOWS) { errno=EINVAL;return -1; }
        if(still_process((pid_t)owner,(uint64_t)start)) { errno=EBUSY;return -1; }
        char old_group[80];group_name(old_group,sizeof(old_group),owner,(uint64_t)start,nonce);
        if(aa_remove_events(trace->root,old_group,count)) return -1;
    }
    unsigned nonce;int random=open("/dev/urandom",O_RDONLY|O_CLOEXEC);
    if(random<0) return -1;ssize_t n=read(random,&nonce,sizeof(nonce));close(random);
    if(n!=sizeof(nonce)) { errno=EIO;return -1; }
    uint64_t start;if(aa_starttime((uint32_t)getpid(),&start)) return -1;
    group_name(trace->group,sizeof(trace->group),(uint32_t)getpid(),start,nonce);
    char group_path[192];snprintf(group_path,sizeof(group_path),"%s/events/%s",trace->root,trace->group);
    if(access(group_path,F_OK)==0) { errno=EEXIST;return -1; }
    memset(previous,0,sizeof(previous));
    (void)snprintf(previous,sizeof(previous),"1 %u %llu %08x %u\n",(unsigned)getpid(),(unsigned long long)start,nonce,windows);
    if(pwrite(trace->lock_fd,previous,sizeof(previous),0)!=sizeof(previous) || ftruncate(trace->lock_fd,sizeof(previous))) return -1;
    int pipe_fd[2];if(pipe2(pipe_fd,O_CLOEXEC|O_NONBLOCK)) return -1;
    trace->windows=windows;pid_t owner=getpid();trace->guard_pid=fork();
    if(trace->guard_pid<0) { close(pipe_fd[0]);close(pipe_fd[1]);return -1; }
    if(trace->guard_pid==0) { close(pipe_fd[1]);guard_loop(trace,pipe_fd[0],owner,start,lease_ms); }
    close(pipe_fd[0]);trace->guard_fd=pipe_fd[1];return 0;
}
int aa_trace_heartbeat(struct aa_trace *trace) {
    if(trace->guard_fd<0) return 0;
    const unsigned char byte=1;return write(trace->guard_fd,&byte,1)==1 ? 0 : -1;
}
void aa_owner_close(struct aa_trace *trace) {
    if(trace->guard_fd>=0) { close(trace->guard_fd);trace->guard_fd=-1; }
    if(trace->guard_pid>0) {
        uint64_t end=aa_now()+2000000000ULL;
        while(waitpid(trace->guard_pid,NULL,WNOHANG)==0 && aa_now()<end) {
            struct timespec pause={0,10000000};nanosleep(&pause,NULL);
        }
        trace->guard_pid=0;
    }
    if(trace->lock_fd>=0) { close(trace->lock_fd);trace->lock_fd=-1; }
}
