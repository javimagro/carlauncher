/* SPDX-License-Identifier: MIT. No commands other than two MAIN profiles. */
#include "bridge-private.h"
#include "bridge-protocol.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/un.h>
#include <unistd.h>

static void lost_client(int *client, uint64_t *owned_epoch) {
    if (*client >= 0) close(*client);
    *client = -1;
    pthread_mutex_lock(&bm.state_lock);
    bm_disconnect(&bm.state, owned_epoch);
    pthread_mutex_unlock(&bm.state_lock);
}
static int send_status(int client, const char *result) {
    char line[768];
    struct bm_state s;
    struct bm_baseline observed;
    uint32_t theme;
    int theme_present;
    pthread_mutex_lock(&bm.state_lock);
    s = bm.state;
    observed = bm.observed;
    theme = bm.current_theme;
    theme_present = bm.theme_present;
    pthread_mutex_unlock(&bm.state_lock);
    int size = snprintf(line, sizeof(line),
        "{\"v\":%d,\"marker\":\"%s\",\"starttime\":\"%llu\",\"rearm\":1,\"leaseMs\":1000,\"ackMs\":2000,"
        "\"generation\":%llu,\"updateSeq\":%llu,\"setStartedNs\":\"%llu\","
        "\"result\":\"%s\",\"pid\":%ld,\"epoch\":%llu,\"phase\":\"%s\",\"writes\":%d,"
        "\"baseline\":%d,\"insets\":[%u,%u,%u,%u],\"dirty\":%d,\"uncertain\":%d,"
        "\"updates\":%llu,\"ignored\":%llu,\"faults\":%llu,\"config\":%u,"
        "\"source\":\"%s\",\"sourceFlags\":%u,\"uiFlags\":%u,\"themePresent\":%d,\"theme\":%u}\n",
        BM_PROTOCOL_VERSION, BM_MARKER, (unsigned long long)bm.starttime,
        (unsigned long long)s.generation, (unsigned long long)s.ack_count,
        (unsigned long long)s.set_started_ns,
        result, (long)getpid(), (unsigned long long)s.epoch, bm_name(s.phase), BM_ENABLE_WRITES,
        s.baseline_valid, s.baseline.value[0], s.baseline.value[1],
        s.baseline.value[2], s.baseline.value[3], s.dirty, s.uncertain,
        (unsigned long long)s.ack_count, (unsigned long long)s.ignored,
        (unsigned long long)s.faults, observed.config,
        observed.legacy ? "legacy" : "selected-insets", observed.selected_mask,
        observed.ui_flags, theme_present, theme);
    return size > 0 && (size_t)size < sizeof(line) &&
           send(client, line, (size_t)size, MSG_NOSIGNAL) == size;
}
static int command(int client, uint64_t *owned_epoch, char *line) {
    struct bm_command cmd;
    if (!bm_parse_command(line, &cmd)) return 0;
    if (cmd.kind == BM_CMD_GET) return send_status(client, "ok");
    if (cmd.kind == BM_CMD_CLOSE) return 0;
    pthread_mutex_lock(&bm.state_lock);
    int ok = bm_control(&bm.state, owned_epoch, &cmd,
                        BM_ENABLE_WRITES && !bm.disabled, bm_clock());
    pthread_mutex_unlock(&bm.state_lock);
    return send_status(client, ok ? "accepted" : "rejected");
}
void *bm_server(void *unused) {
    (void)unused;
    char directory[48], process[4096];
    int process_fd = open("/proc/self/stat", O_RDONLY | O_CLOEXEC);
    if (process_fd < 0) { bm_diag(BM_D_SOCKET_IDENTITY); goto disabled; }
    ssize_t bytes = read(process_fd, process, sizeof(process) - 1);
    close(process_fd);
    if (bytes <= 0 || (size_t)bytes == sizeof(process) - 1) {
        bm_diag(BM_D_SOCKET_IDENTITY); goto disabled;
    }
    process[bytes] = 0;
    if (!bm_parse_starttime(process, (uint32_t)getpid(), &bm.starttime)) {
        bm_diag(BM_D_SOCKET_IDENTITY); goto disabled;
    }
    struct stat parent_info, base_info, directory_info, socket_info;
    int directory_fd = -1, bound = 0;
    int parent_fd = open(BM_SOCKET_PARENT, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (parent_fd < 0) { bm_diag(BM_D_SOCKET_BASE); goto disabled; }
    if (fstat(parent_fd, &parent_info) ||
        !bm_profile_parent(parent_info.st_mode, parent_info.st_uid, parent_info.st_gid)) {
        bm_diag(BM_D_SOCKET_BASE_MODE); goto close_parent;
    }
    if (mkdirat(parent_fd, BM_SOCKET_DIRECTORY, 0700) && errno != EEXIST) {
        bm_diag(BM_D_SOCKET_BASE); goto close_parent;
    }
    int base_fd = openat(parent_fd, BM_SOCKET_DIRECTORY, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (base_fd < 0) { bm_diag(BM_D_SOCKET_BASE); goto close_parent; }
    if (fstat(base_fd, &base_info) ||
        !bm_profile_directory(base_info.st_mode, base_info.st_uid, base_info.st_gid)) {
        bm_diag(BM_D_SOCKET_BASE_MODE); goto close_base;
    }
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    int n = snprintf(directory, sizeof(directory), "%ld-%llu", (long)getpid(),
                     (unsigned long long)bm.starttime);
    if (n < 0 || (size_t)n >= sizeof(directory) || mkdirat(base_fd, directory, 0700)) {
        bm_diag(BM_D_SOCKET_DIRECTORY); goto close_base;
    } /* Never steal an existing process-identity directory. */
    directory_fd = openat(base_fd, directory, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory_fd < 0) { bm_diag(BM_D_SOCKET_DIRECTORY); goto close_base; }
    if (fstat(directory_fd, &directory_info) ||
        !bm_profile_directory(directory_info.st_mode, directory_info.st_uid, directory_info.st_gid)) {
        bm_diag(BM_D_SOCKET_DIRECTORY_MODE); goto close_directory;
    }
    n = snprintf(address.sun_path, sizeof(address.sun_path), "%s/%s/control", BM_SOCKET_BASE, directory);
    if (n < 0 || (size_t)n >= sizeof(address.sun_path)) goto remove_directory;
    int listener = socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
    if (listener < 0) goto remove_directory;
    if (bind(listener, (struct sockaddr *)&address, sizeof(address))) {
        bm_diag(BM_D_SOCKET_BIND); goto remove_socket;
    }
    if (fstatat(directory_fd, "control", &socket_info, AT_SYMLINK_NOFOLLOW) ||
        !S_ISSOCK(socket_info.st_mode) || socket_info.st_uid != BM_DAEMON_UID ||
        socket_info.st_gid != BM_DAEMON_GID) { bm_diag(BM_D_SOCKET_BIND); goto remove_socket; }
    bound = 1;
    if (fchmodat(directory_fd, "control", 0600, 0) || listen(listener, 1)) {
        bm_diag(BM_D_SOCKET_BIND); goto remove_socket;
    }
    bm_diag(BM_D_SOCKET_READY);
    int client = -1;
    uint64_t owned_epoch = 0;
    size_t used = 0;
    char line[128];
    uint64_t previous_epoch = UINT64_MAX;
    uint64_t client_until = 0;
    enum bm_phase previous_phase = BM_BLOCKED;
    for (;;) {
        struct pollfd fds[2] = {{listener, POLLIN, 0}, {client, POLLIN, 0}};
        int ready = poll(fds, 2, 50);
        if (ready < 0 && errno != EINTR) break;
        if (fds[0].revents & (POLLHUP | POLLERR | POLLNVAL)) break;
        if (client >= 0 && bm_clock() >= client_until) {
            lost_client(&client, &owned_epoch);
            fds[1].fd = -1; /* accept may immediately reuse the closed fd. */
        }
        if (fds[0].revents & POLLIN) {
            int incoming = accept4(listener, NULL, NULL, SOCK_NONBLOCK | SOCK_CLOEXEC);
            if (incoming >= 0) {
                struct ucred cred;
                socklen_t size = sizeof(cred);
                if (client >= 0 || getsockopt(incoming, SOL_SOCKET, SO_PEERCRED, &cred, &size) ||
                    size != sizeof(cred) || !bm_profile_peer(cred.uid)) close(incoming);
                else {
                    client = incoming;
                    used = 0;
                    client_until = bm_clock() + BM_CLIENT_IDLE_MS;
                    if (!send_status(client, "hello")) lost_client(&client, &owned_epoch);
                }
            }
        }
        if (client >= 0 && client == fds[1].fd &&
            (fds[1].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) {
            char input[128];
            ssize_t bytes = recv(client, input, sizeof(input), 0);
            if (bytes <= 0) {
                if (!bytes || (errno != EAGAIN && errno != EWOULDBLOCK)) lost_client(&client, &owned_epoch);
            } else for (ssize_t i = 0; i < bytes && client >= 0; ++i) {
                unsigned char c = (unsigned char)input[i];
                if (c == '\n') {
                    line[used] = 0;
                    used = 0;
                    if (!command(client, &owned_epoch, line)) lost_client(&client, &owned_epoch);
                    else client_until = bm_clock() + BM_CLIENT_IDLE_MS;
                } else if (c < 32 || c > 126 || used == sizeof(line) - 1) lost_client(&client, &owned_epoch);
                else line[used++] = (char)c;
            }
        }
        bm_perform();
        pthread_mutex_lock(&bm.state_lock);
        enum bm_phase phase = bm.state.phase;
        uint64_t epoch = bm.state.epoch;
        pthread_mutex_unlock(&bm.state_lock);
        if (phase != previous_phase || epoch != previous_epoch) {
            previous_phase = phase;
            previous_epoch = epoch;
            if (client >= 0 && !send_status(client, "state")) lost_client(&client, &owned_epoch);
        }
    }
    lost_client(&client, &owned_epoch);
    /* A polling failure still attempts one bounded-protocol restoration.
     * The Cinemo call itself has no proven hard deadline (documented gate). */
    for (unsigned i = 0; i < 90; ++i) { bm_perform(); poll(NULL, 0, 50); }
remove_socket:
    close(listener);
    if (bound) {
        struct stat current;
        if (!fstatat(directory_fd, "control", &current, AT_SYMLINK_NOFOLLOW) &&
            current.st_dev == socket_info.st_dev && current.st_ino == socket_info.st_ino)
            unlinkat(directory_fd, "control", 0);
    }
remove_directory:
    {
        struct stat current;
        if (!fstatat(base_fd, directory, &current, AT_SYMLINK_NOFOLLOW) &&
            current.st_dev == directory_info.st_dev && current.st_ino == directory_info.st_ino)
            unlinkat(base_fd, directory, AT_REMOVEDIR);
    }
close_directory:
    close(directory_fd);
close_base:
    close(base_fd); /* Base may outlive us; never remove or repair it. */
close_parent:
    close(parent_fd);
disabled:
    bm.disabled = 1;
    return NULL;
}
