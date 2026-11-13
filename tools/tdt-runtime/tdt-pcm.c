/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include <dlfcn.h>
#include <errno.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>

typedef struct _snd_pcm snd_pcm_t;
typedef unsigned long pcm_frames;
typedef long pcm_result;

enum {
    playback = 0, signed_le16 = 2, interleaved = 3,
    channels = 2, rate = 48000, frame_bytes = channels * 2
};

int main(int argc, char **argv)
{
    if (argc != 2) return 2;
    void *alsa = dlopen("libasound.so.2", RTLD_NOW | RTLD_LOCAL);
    if (!alsa) return 3;

    int (*open_pcm)(snd_pcm_t **, const char *, int, int) = dlsym(alsa, "snd_pcm_open");
    int (*setup)(snd_pcm_t *, int, int, unsigned, unsigned, int, unsigned) = dlsym(alsa, "snd_pcm_set_params");
    int (*nonblock)(snd_pcm_t *, int) = dlsym(alsa, "snd_pcm_nonblock");
    int (*state_pcm)(snd_pcm_t *) = dlsym(alsa, "snd_pcm_state");
    pcm_result (*write_pcm)(snd_pcm_t *, const void *, pcm_frames) = dlsym(alsa, "snd_pcm_writei");
    int (*recover)(snd_pcm_t *, int, int) = dlsym(alsa, "snd_pcm_recover");
    int (*close_pcm)(snd_pcm_t *) = dlsym(alsa, "snd_pcm_close");
    if (!open_pcm || !setup || !write_pcm || !recover || !close_pcm) return 3;

    snd_pcm_t *pcm = NULL;
    int error = open_pcm(&pcm, argv[1], playback, 0);
    if (error < 0) {
        fprintf(stderr, "tdt-pcm: open=%d\n", error);
        return 4;
    }
    error = setup(pcm, signed_le16, interleaved, channels, rate, 1, 120000);
    if (error < 0) {
        fprintf(stderr, "tdt-pcm: format=%d\n", error);
        close_pcm(pcm);
        return 5;
    }
    // Keep writes interruptible once the output is configured.
    if (nonblock) {
        error = nonblock(pcm, 1);
        if (error < 0) {
            fprintf(stderr, "tdt-pcm: nonblock=%d\n", error);
            close_pcm(pcm);
            return 5;
        }
    }
    puts("ready");
    fflush(stdout);

    unsigned char bytes[4096];
    size_t kept = 0;
    int status = 0;
    for (;;) {
        ssize_t got = read(STDIN_FILENO, bytes + kept, sizeof(bytes) - kept);
        if (got == 0) break;
        if (got < 0) {
            if (errno == EINTR) continue;
            status = 6;
            break;
        }

        size_t size = kept + (size_t)got;
        pcm_frames frames = size / frame_bytes;
        pcm_frames at = 0;
        unsigned retries = 0;
        while (at < frames) {
            pcm_result count = write_pcm(pcm, bytes + at * frame_bytes, frames - at);
            if (count > 0) {
                at += (pcm_frames)count;
                retries = 0;
                continue;
            }
            if (count && count != -EAGAIN) {
                error = recover(pcm, (int)count, 1);
                if (error < 0) {
                    if (state_pcm) fprintf(stderr, "tdt-pcm: state=%d\n", state_pcm(pcm));
                    fprintf(stderr, "tdt-pcm: write=%ld\ntdt-pcm: recover=%d\n", count, error);
                    status = 7;
                    break;
                }
            }
            if (++retries >= 100) {
                if (state_pcm) fprintf(stderr, "tdt-pcm: state=%d\n", state_pcm(pcm));
                fprintf(stderr, "tdt-pcm: stall=%ld\n", count);
                status = 8;
                break;
            }
            const struct timespec pause = { 0, 10000000 };
            nanosleep(&pause, NULL);
        }
        if (status) break;
        kept = size % frame_bytes;
        for (size_t i = 0; i < kept; i++) bytes[i] = bytes[frames * frame_bytes + i];
    }
    close_pcm(pcm);
    dlclose(alsa);
    return status;
}
