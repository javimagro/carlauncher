/* SPDX-License-Identifier: MIT
 * Capability probe only. No decoding, focus changes or ALSA playback.
 * libva 1.x public ABI: intel/libva 1.8.3 va/va.h and va/va_drm.h.
 * Run as the decoder's effective UID, not as root to bypass permissions.
 */
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <unistd.h>

typedef void *VADisplay;
typedef struct { int type; unsigned int value; } VAConfigAttrib;

int main(void)
{
    struct stat info;
    int fd = -1, started = 0, status = 1;
    void *va = NULL, *drm = NULL, *mfx = NULL;
    VADisplay display = NULL;
    int (*terminate)(VADisplay) = NULL;
    printf("{\"uid\":%lu,\"gid\":%lu", (unsigned long)geteuid(), (unsigned long)getegid());
    if (stat("/dev/dri/renderD128", &info) != 0) {
        printf(",\"stage\":\"device-stat\",\"errno\":%d", errno); goto done;
    }
    printf(",\"deviceMode\":%u,\"deviceGid\":%lu", (unsigned)(info.st_mode & 0777), (unsigned long)info.st_gid);
    fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (fd < 0) { printf(",\"stage\":\"device-open\",\"errno\":%d", errno); goto done; }
    va = dlopen("libva.so.1", RTLD_NOW | RTLD_LOCAL);
    drm = dlopen("libva-drm.so.1", RTLD_NOW | RTLD_LOCAL);
    if (!va || !drm) { printf(",\"stage\":\"libva-1-loader\""); goto done; }
    VADisplay (*get_display)(int) = dlsym(drm, "vaGetDisplayDRM");
    int (*initialize)(VADisplay, int *, int *) = dlsym(va, "vaInitialize");
    int (*max_profiles)(VADisplay) = dlsym(va, "vaMaxNumProfiles");
    int (*query_profiles)(VADisplay, int *, int *) = dlsym(va, "vaQueryConfigProfiles");
    int (*max_entrypoints)(VADisplay) = dlsym(va, "vaMaxNumEntrypoints");
    int (*query_entrypoints)(VADisplay, int, int *, int *) = dlsym(va, "vaQueryConfigEntrypoints");
    int (*attributes)(VADisplay, int, int, VAConfigAttrib *, int) = dlsym(va, "vaGetConfigAttributes");
    terminate = dlsym(va, "vaTerminate");
    if (!get_display || !initialize || !terminate || !max_profiles || !query_profiles || !max_entrypoints || !query_entrypoints || !attributes) {
        printf(",\"stage\":\"libva-symbols\""); goto done;
    }
    display = get_display(fd);
    if (!display) { printf(",\"stage\":\"va-display\""); goto done; }
    int major = 0, minor = 0, result = initialize(display, &major, &minor);
    if (result) { printf(",\"stage\":\"va-initialize\",\"status\":%d", result); goto done; }
    started = 1;
    printf(",\"vaMajor\":%d,\"vaMinor\":%d", major, minor);
    int profiles[256], entrypoints[256], count = 0;
    if (max_profiles(display) < 1 || max_profiles(display) > 256 || max_entrypoints(display) < 1 || max_entrypoints(display) > 256) {
        printf(",\"stage\":\"query-bounds\""); goto done;
    }
    result = query_profiles(display, profiles, &count);
    if (result || count < 0 || count > 256) { printf(",\"stage\":\"query-profiles\",\"status\":%d", result); goto done; }
    printf(",\"profiles\":[");
    for (int i = 0; i < count; i++) {
        int entries = 0, vld = 0;
        result = query_entrypoints(display, profiles[i], entrypoints, &entries);
        if (!result && entries >= 0 && entries <= 256)
            for (int n = 0; n < entries; n++) if (entrypoints[n] == 1) vld = 1; /* VAEntrypointVLD */
        VAConfigAttrib attr = { 0, 0 }; /* VAConfigAttribRTFormat */
        int attr_status = vld ? attributes(display, profiles[i], 1, &attr, 1) : -1;
        printf("%s{\"id\":%d,\"decodeVld\":%s,\"yuv420\":%s}", i ? "," : "", profiles[i],
            vld ? "true" : "false", !attr_status && attr.value != 0xffffffffU && (attr.value & 1U) ? "true" : "false");
    }
    printf("]");
    mfx = dlopen("libmfxhw64-p.so.1.24", RTLD_NOW | RTLD_LOCAL);
    if (!mfx) mfx = dlopen("libmfxhw64.so", RTLD_NOW | RTLD_LOCAL);
    printf(",\"mfx124Loads\":%s,\"mfxDecodeSymbol\":%s,\"stage\":\"capabilities-only\"",
        mfx ? "true" : "false", mfx && dlsym(mfx, "MFXVideoDECODE_DecodeFrameAsync") ? "true" : "false");
    status = 0;
done:
    printf(",\"decodedFrames\":0,\"hardwarePlaybackVerified\":false}\n");
    if (mfx) dlclose(mfx);
    if (started) terminate(display);
    if (drm) dlclose(drm);
    if (va) dlclose(va);
    if (fd >= 0) close(fd);
    return status;
}
