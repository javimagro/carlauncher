/* SPDX-License-Identifier: MIT
 * Bounded decode experiment: public Intel Media SDK 1.x ABI, MGU libraries.
 * Input is a local AVC Annex-B fixture, never a URL. No display/audio/focus.
 */
#define _POSIX_C_SOURCE 200809L
#include <mfxvideo.h>
#include <dlfcn.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef void *VADisplay;
static double now_ms(void) {
    struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1000.0 + t.tv_nsec / 1000000.0;
}
#define LOAD(lib, name) __typeof__(&name) p_##name = dlsym(lib, #name)
#define REQUIRE(name) do { if (!p_##name) { stage = #name "-symbol"; goto finish; } } while (0)
#define CALL(label, expression) do { stage = label; code = (expression); if (code < 0) goto finish; } while (0)

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    alarm(25);
    const char *stage = "load";
    int code = -1, fd = -1, va_started = 0, decode_started = 0;
    unsigned frames = 0, checksum = 0, count = 0;
    double start = now_ms(), first = -1;
    void *va = NULL, *drm = NULL, *mfx = NULL;
    VADisplay display = NULL;
    mfxSession session = NULL;
    mfxFrameSurface1 surfaces[32] = {0};
    unsigned char *pixels[32] = {0}, *input = NULL;
    int (*terminate_va)(VADisplay) = NULL;
    mfxStatus (*close_session)(mfxSession) = NULL, (*close_decode)(mfxSession) = NULL;
    FILE *file = fopen(argv[1], "rb");
    if (!file) return 3;
    input = malloc(4 * 1024 * 1024);
    if (!input) { fclose(file); return 3; }
    size_t length = fread(input, 1, 4 * 1024 * 1024, file);
    int extra = fgetc(file); fclose(file);
    if (!length || extra != EOF) { free(input); return 3; }
    fd = open("/dev/dri/renderD128", O_RDWR | O_CLOEXEC);
    if (fd < 0) { stage = "device"; goto finish; }
    va = dlopen("libva.so.1", RTLD_NOW | RTLD_LOCAL);
    drm = dlopen("libva-drm.so.1", RTLD_NOW | RTLD_LOCAL);
    mfx = dlopen("libmfxhw64-p.so.1.24", RTLD_NOW | RTLD_LOCAL);
    if (!va || !drm || !mfx) goto finish;
    VADisplay (*get_display)(int) = dlsym(drm, "vaGetDisplayDRM");
    int (*initialize_va)(VADisplay, int *, int *) = dlsym(va, "vaInitialize");
    terminate_va = dlsym(va, "vaTerminate");
    if (!get_display || !initialize_va || !terminate_va) goto finish;
    display = get_display(fd);
    int major = 0, minor = 0;
    CALL("vaInitialize", initialize_va(display, &major, &minor)); va_started = 1;
    LOAD(mfx, MFXInitEx); LOAD(mfx, MFXQueryIMPL);
    LOAD(mfx, MFXVideoCORE_SetHandle); LOAD(mfx, MFXVideoDECODE_DecodeHeader);
    LOAD(mfx, MFXVideoDECODE_QueryIOSurf); LOAD(mfx, MFXVideoDECODE_Init);
    LOAD(mfx, MFXVideoDECODE_DecodeFrameAsync); LOAD(mfx, MFXVideoCORE_SyncOperation);
    REQUIRE(MFXInitEx); REQUIRE(MFXQueryIMPL); REQUIRE(MFXVideoCORE_SetHandle);
    REQUIRE(MFXVideoDECODE_DecodeHeader); REQUIRE(MFXVideoDECODE_QueryIOSurf);
    REQUIRE(MFXVideoDECODE_Init); REQUIRE(MFXVideoDECODE_DecodeFrameAsync); REQUIRE(MFXVideoCORE_SyncOperation);
    close_session = dlsym(mfx, "MFXClose"); close_decode = dlsym(mfx, "MFXVideoDECODE_Close");
    if (!close_session || !close_decode) goto finish;
    mfxInitParam init = {0}; init.Implementation = MFX_IMPL_HARDWARE | MFX_IMPL_VIA_VAAPI;
    init.Version.Major = 1; init.Version.Minor = 24; init.GPUCopy = MFX_GPUCOPY_OFF;
    CALL("MFXInitEx", p_MFXInitEx(init, &session));
    mfxIMPL implementation = 0;
    CALL("MFXQueryIMPL", p_MFXQueryIMPL(session, &implementation));
    if (MFX_IMPL_BASETYPE(implementation) != MFX_IMPL_HARDWARE) { stage = "not-hardware"; code = -1; goto finish; }
    CALL("SetHandle", p_MFXVideoCORE_SetHandle(session, MFX_HANDLE_VA_DISPLAY, display));
    mfxBitstream bs = {0}; bs.Data = input; bs.DataLength = bs.MaxLength = (mfxU32)length;
    mfxVideoParam par = {0}; par.mfx.CodecId = MFX_CODEC_AVC;
    CALL("DecodeHeader", p_MFXVideoDECODE_DecodeHeader(session, &bs, &par));
    par.IOPattern = MFX_IOPATTERN_OUT_SYSTEM_MEMORY; par.AsyncDepth = 1;
    mfxFrameAllocRequest request = {0};
    CALL("QueryIOSurf", p_MFXVideoDECODE_QueryIOSurf(session, &par, &request));
    count = request.NumFrameSuggested;
    unsigned w = par.mfx.FrameInfo.Width, h = par.mfx.FrameInfo.Height;
    if (!count || count > 32 || !w || !h || w > 1920 || h > 1088 || (size_t)w*h*3/2*count > 128*1024*1024) { stage = "bounds"; code = -1; goto finish; }
    for (unsigned i = 0; i < count; i++) {
        pixels[i] = calloc((size_t)w * h * 3 / 2, 1);
        if (!pixels[i]) { stage = "allocate"; code = -1; goto finish; }
        surfaces[i].Info = par.mfx.FrameInfo;
        surfaces[i].Data.Y = pixels[i]; surfaces[i].Data.UV = pixels[i] + w*h;
        surfaces[i].Data.Pitch = (mfxU16)w;
    }
    CALL("DecodeInit", p_MFXVideoDECODE_Init(session, &par)); decode_started = 1;
    int draining = 0;
    while (frames < 1000 && now_ms() - start < 18000) {
        unsigned index = 0; while (index < count && surfaces[index].Data.Locked) index++;
        if (index == count) { stage = "no-free-surface"; code = -1; break; }
        mfxFrameSurface1 *out = NULL; mfxSyncPoint sync = NULL;
        stage = "DecodeFrame";
        code = p_MFXVideoDECODE_DecodeFrameAsync(session, draining ? NULL : &bs, &surfaces[index], &out, &sync);
        if (code == MFX_ERR_MORE_DATA) {
            if (draining) { code = 0; break; }
            draining = 1; continue;
        }
        if (code == MFX_WRN_DEVICE_BUSY) { const struct timespec pause = {0,1000000}; nanosleep(&pause,NULL); continue; }
        if (code == MFX_ERR_MORE_SURFACE) continue;
        if (code < 0) break;
        if (!sync || !out) continue;
        CALL("Sync", p_MFXVideoCORE_SyncOperation(session, sync, 1000));
        if (code != MFX_ERR_NONE) break;
        if (first < 0) first = now_ms() - start;
        for (unsigned y = 0; y < out->Info.CropH; y++) checksum = checksum * 33U + out->Data.Y[(y+out->Info.CropY)*out->Data.Pitch+out->Info.CropX];
        frames++;
    }
finish:
    if (decode_started) close_decode(session);
    if (session && close_session) close_session(session);
    if (va_started) terminate_va(display);
    if (mfx) dlclose(mfx);
    if (drm) dlclose(drm);
    if (va) dlclose(va);
    if (fd >= 0) close(fd);
    for (unsigned i = 0; i < 32; i++) free(pixels[i]);
    free(input); alarm(0);
    printf("{\"stage\":\"%s\",\"status\":%d,\"decodedFrames\":%u,\"checksum\":%u,\"firstMs\":%.1f,\"elapsedMs\":%.1f}\n",stage,code,frames,checksum,first,now_ms()-start);
    return frames && code == 0 ? 0 : 1;
}
