/* SPDX-License-Identifier: MIT */
#include "bridge-private.h"
#include "aa-capture.h" /* Reuse our own SHA-256 implementation, not SDK data. */
#include <dlfcn.h>
#include <fcntl.h>
#include <link.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

struct image { uintptr_t base; unsigned count; char path[512]; };
struct images { struct image app, aa, base; };
static int images(struct dl_phdr_info *info, size_t size, void *data) {
    (void)size;
    struct images *all = data;
    const char *path = info->dlpi_name, *name = strrchr(path, '/');
    struct image *image = NULL;
    name = name ? name + 1 : path;
    if (!*path) image = &all->app;
    else if (!strcmp(name, "libNmeAndroidAuto.so")) image = &all->aa;
    else if (!strcmp(name, "libNmeBaseClasses.so")) image = &all->base;
    if (image) {
        ++image->count;
        image->base = info->dlpi_addr;
        if (strlen(path) < sizeof(image->path)) strcpy(image->path, path);
    }
    return 0;
}
static int mapped_file(uintptr_t address, const struct stat *file) {
    FILE *maps = fopen("/proc/self/maps", "re");
    if (!maps) return 0;
    char line[1024], permissions[5];
    unsigned long start, end;
    unsigned long long offset, inode;
    unsigned major_id, minor_id;
    int found = 0;
    while (fgets(line, sizeof(line), maps)) {
        if (sscanf(line, "%lx-%lx %4s %llx %x:%x %llu", &start, &end,
                   permissions, &offset, &major_id, &minor_id, &inode) != 7) continue;
        if (address >= start && address < end) {
            found = file->st_ino == inode && major(file->st_dev) == major_id &&
                    minor(file->st_dev) == minor_id && permissions[0] == 'r';
            break;
        }
    }
    fclose(maps);
    return found;
}
static int identity(const char *path, uintptr_t address, const char *expected) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    struct stat st;
    int valid = !fstat(fd, &st) && S_ISREG(st.st_mode) && st.st_uid == 0 &&
                !(st.st_mode & 0022) && st.st_size > 0 && st.st_size <= 64 * 1024 * 1024 &&
                mapped_file(address, &st);
    struct aa_sha256 hash;
    unsigned char buffer[16384], digest[32];
    char hex[65];
    aa_sha256_init(&hash);
    ssize_t n;
    if (valid) {
        while ((n = read(fd, buffer, sizeof(buffer))) > 0)
            aa_sha256_update(&hash, buffer, (size_t)n);
        if (n < 0) valid = 0;
    }
    close(fd);
    aa_sha256_final(&hash, digest);
    aa_sha256_hex(digest, hex);
    return valid && !strcmp(hex, expected);
}
int bm_guard(void *factory, uintptr_t *app, uintptr_t *aa) {
    uid_t ruid, euid, suid;
    gid_t rgid, egid, sgid;
    if (getresuid(&ruid, &euid, &suid) || getresgid(&rgid, &egid, &sgid) ||
        !bm_profile_identity(ruid, euid, suid, rgid, egid, sgid)) {
        bm_diag(BM_D_GUARD_IDENTITY); return 0;
    }
    struct images found;
    Dl_info sdk;
    memset(&found, 0, sizeof(found));
    if (!dladdr(factory, &sdk)) { bm_diag(BM_D_GUARD_LAYOUT); return 0; }
    dl_iterate_phdr(images, &found);
    if (found.app.count != 1 || found.aa.count != 1 || found.base.count != 1 ||
        !*found.aa.path || !*found.base.path ||
        (uintptr_t)factory != (uintptr_t)sdk.dli_fbase + BMW_AA_SDK_FACTORY_RVA) {
        bm_diag(BM_D_GUARD_LAYOUT); return 0;
    }
    if (!identity("/proc/self/exe", found.app.base + 0x354e50, BMW_AA_AAPD_SHA256)) {
        bm_diag(BM_D_GUARD_EXE); return 0;
    }
    if (!identity(found.aa.path, found.aa.base + BMW_AA_GET_DISPLAY_RVA, BMW_AA_LIBRARY_SHA256)) {
        bm_diag(BM_D_GUARD_AA); return 0;
    }
    if (!identity(found.base.path, found.base.base + 0x1834e0, BMW_AA_BASE_CLASSES_SHA256)) {
        bm_diag(BM_D_GUARD_BASE); return 0;
    }
    if (!identity(sdk.dli_fname, (uintptr_t)factory, BMW_AA_SDK_SHA256)) {
        bm_diag(BM_D_GUARD_SDK); return 0;
    }
    *app = found.app.base;
    *aa = found.aa.base;
    bm_diag(BM_D_GUARD_OK);
    return 1;
}
