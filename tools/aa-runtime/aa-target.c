/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "aa-platform.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>
uint64_t aa_now(void) {
    struct timespec t;if(clock_gettime(CLOCK_MONOTONIC,&t)) return 0;
    return (uint64_t)t.tv_sec*1000000000+(uint64_t)t.tv_nsec;
}
void aa_log(const char *type,const char *code,int number) {
    /* All strings originate in this executable, never in captured memory. */
    char line[256];int n=snprintf(line,sizeof(line),"{\"type\":\"%s\",\"code\":\"%s\",\"errno\":%d}\n",type,code,number);
    if(n>0 && (size_t)n<sizeof(line)) (void)write(STDERR_FILENO,line,(size_t)n);
}
int aa_starttime(uint32_t pid,uint64_t *starttime) {
    char path[64],data[4096];snprintf(path,sizeof(path),"/proc/%u/stat",pid);
    int fd=open(path,O_RDONLY|O_CLOEXEC);if(fd<0) return -1;
    ssize_t n=read(fd,data,sizeof(data)-1);close(fd);if(n<=0) return -1;data[n]=0;
    char *p=strrchr(data,')');if(!p || p[1]!=' ') return -1;p+=2;
    for(unsigned field=3;field<=22;field++) {
        char *end=strchr(p,' ');
        if(field==22) {
            char *parsed;errno=0;unsigned long long value=strtoull(p,&parsed,10);
            if(errno || !value || parsed==p || (parsed!=end && *parsed!='\0')) return -1;
            *starttime=(uint64_t)value;return 0;
        }
        if(!end) return -1;p=end+1;
    }
    return -1;
}
static int hash_path(const char *path,const char *expected,struct stat *identity) {
    int fd=open(path,O_RDONLY|O_CLOEXEC);if(fd<0) return -1;
    struct stat before,after;int result=-1;
    if(fstat(fd,&before) || !S_ISREG(before.st_mode) || before.st_size<1 || before.st_size>128*1024*1024) goto done;
    struct aa_sha256 sha;aa_sha256_init(&sha);unsigned char data[16384],digest[32];char hex[65];
    off_t total=0;
    for(;;) {
        ssize_t n=read(fd,data,sizeof(data));
        if(n<0 && errno==EINTR) continue;
        if(n<0) goto done;if(!n) break;
        total+=n;if(total>before.st_size) goto done;aa_sha256_update(&sha,data,(size_t)n);
    }
    if(total!=before.st_size || fstat(fd,&after) || before.st_dev!=after.st_dev || before.st_ino!=after.st_ino ||
       before.st_size!=after.st_size || before.st_mtim.tv_sec!=after.st_mtim.tv_sec || before.st_mtim.tv_nsec!=after.st_mtim.tv_nsec) goto done;
    aa_sha256_final(&sha,digest);aa_sha256_hex(digest,hex);
    if(strcmp(hex,expected)) { errno=ENOTSUP;goto done; }
    *identity=before;result=0;
done: close(fd);return result;
}
static int named_aapd(uint32_t pid) {
    char path[64],comm[32];snprintf(path,sizeof(path),"/proc/%u/comm",pid);
    int fd=open(path,O_RDONLY|O_CLOEXEC);if(fd<0) return 0;
    ssize_t n=read(fd,comm,sizeof(comm)-1);close(fd);if(n<0) return 0;comm[n]=0;
    return !strcmp(comm,"aapd\n");
}
static int mapped_library(const struct aa_target *target) {
    char path[64],line[1024];snprintf(path,sizeof(path),"/proc/%u/maps",target->pid);
    FILE *f=fopen(path,"r");if(!f) return -1;int found=0;
    while(fgets(line,sizeof(line),f)) {
        unsigned long long start,end,offset,inode;unsigned ma,mi;char permissions[5];
        if(sscanf(line,"%llx-%llx %4s %llx %x:%x %llu",&start,&end,permissions,&offset,&ma,&mi,&inode)!=7) continue;
        if(inode==(unsigned long long)target->library.st_ino && makedev(ma,mi)==target->library.st_dev &&
           strchr(permissions,'x') && end>start && AA_OFFSET>=offset && AA_OFFSET-offset<end-start) { found=1;break; }
    }
    fclose(f);return found ? 0 : -1;
}
int aa_target_current(const struct aa_target *target) {
    uint64_t start;struct stat executable,library;char path[64];
    snprintf(path,sizeof(path),"/proc/%u/exe",target->pid);
    return aa_starttime(target->pid,&start)==0 && start==target->starttime && named_aapd(target->pid) &&
        stat(path,&executable)==0 && executable.st_dev==target->executable.st_dev && executable.st_ino==target->executable.st_ino &&
        stat(AA_LIBRARY,&library)==0 && library.st_dev==target->library.st_dev && library.st_ino==target->library.st_ino &&
        library.st_size==target->library.st_size && library.st_mtim.tv_sec==target->library.st_mtim.tv_sec &&
        library.st_mtim.tv_nsec==target->library.st_mtim.tv_nsec ? 0 : -1;
}
static int validate(struct aa_target *target,uint32_t pid,uint64_t expected,const char **reason) {
    char path[64];memset(target,0,sizeof(*target));target->pid=pid;
    *reason="target-identity";
    if(!named_aapd(pid) || aa_starttime(pid,&target->starttime) || (expected && expected!=target->starttime)) return -1;
    *reason="unsupported-library";if(hash_path(AA_LIBRARY,AA_LIBRARY_SHA,&target->library)) return -1;
    snprintf(path,sizeof(path),"/proc/%u/exe",pid);
    *reason="unsupported-aapd";if(hash_path(path,AA_EXE_SHA,&target->executable)) return -1;
    *reason="target-changed";if(aa_target_current(target)) return -1;
    *reason="library-not-mapped";if(mapped_library(target)) return -1;
    *reason="ok";return 0;
}
int aa_target_find(struct aa_target *target,uint32_t pid,uint64_t expected,const char **reason) {
    if(pid) return validate(target,pid,expected,reason);
    DIR *dir=opendir("/proc");if(!dir) { *reason="proc-unavailable";return -1; }
    struct dirent *entry;uint32_t candidate=0;unsigned visited=0;
    while((entry=readdir(dir)) && visited++<65536) {
        char *end;errno=0;unsigned long n=strtoul(entry->d_name,&end,10);
        if(errno || !n || n>INT32_MAX || *end || end==entry->d_name || !named_aapd((uint32_t)n)) continue;
        if(candidate) { closedir(dir);*reason="multiple-aapd";return -1; }
        candidate=(uint32_t)n;
    }
    closedir(dir);if(!candidate) { *reason="aapd-unavailable";return -1; }
    return validate(target,candidate,expected,reason);
}
