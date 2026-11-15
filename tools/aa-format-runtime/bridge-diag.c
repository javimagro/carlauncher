/* SPDX-License-Identifier: MIT */
#define _GNU_SOURCE
#include "bridge-diag.h"
#include <errno.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
_Static_assert(BM_D_COUNT <= 64, "one diagnostic bit per fixed event");
static _Atomic uint64_t emitted;
#if BM_ENABLE_WRITES
#define D(event) "{\"aaMargins\":\"write\",\"event\":\"" event "\"}\n"
#else
#define D(event) "{\"aaMargins\":\"observe\",\"event\":\"" event "\"}\n"
#endif
void bm_diag(enum bm_diagnostic event) {
    static const char *const messages[BM_D_COUNT] = {
        D("factory-seen"), D("factory-original-failed"), D("guard-identity-rejected"),
        D("guard-layout-rejected"), D("guard-executable-rejected"),
        D("guard-androidauto-rejected"), D("guard-baseclasses-rejected"),
        D("guard-sdk-rejected"), D("guard-passed"), D("owner-vtable-rejected"),
        D("owner-hooks-ready"), D("callbacks-constructor-rejected"),
        D("callbacks-original-failed"), D("callbacks-ready"),
        D("main-display-rejected"), D("main-display-retained"),
        D("worker-start-failed"), D("worker-started"), D("socket-base-open-failed"),
        D("socket-base-mode-rejected"), D("socket-directory-create-failed"),
        D("socket-directory-mode-rejected"), D("socket-bind-or-mode-failed"),
        D("socket-ready"), D("main-config-observed"), D("baseline-rejected"),
        D("baseline-ready"), D("session-accepted"), D("session-rejected"),
        D("session-ended"), D("socket-process-identity-rejected")
    };
    if ((unsigned)event >= BM_D_COUNT) return;
    uint64_t mask = UINT64_C(1) << event;
    if (atomic_fetch_or(&emitted, mask) & mask) return;
    int saved = errno;
    const char *line = messages[event];
    size_t size = strlen(line); /* <80 bytes, no addresses, IDs or payloads. */
    /* systemd journal stderr is an AF_UNIX socket. Unsupported destinations,
     * backpressure and partial sends are dropped: no retry, blocking file I/O,
     * stderr flag change or SIGPIPE on a closed pipe. */
    ssize_t ignored = send(STDERR_FILENO, line, size, MSG_DONTWAIT | MSG_NOSIGNAL);
    (void)ignored;
    errno = saved;
}
