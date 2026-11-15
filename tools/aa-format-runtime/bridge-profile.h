/* SPDX-License-Identifier: MIT. Build-time identity of the observed service. */
#ifndef BMW_MAIN_BRIDGE_PROFILE_H
#define BMW_MAIN_BRIDGE_PROFILE_H
#include <stdint.h>
#if !defined(BM_DAEMON_UID) || !defined(BM_DAEMON_GID)
#error Compile with the UID/GID verified for this aapd service profile.
#endif
#if BM_DAEMON_UID != 13006 || BM_DAEMON_GID != 13006
#error This pinned service profile is cia_13006, UID=13006 and GID=13006.
#endif
#define BM_SOCKET_PARENT "/tmp"
#define BM_SOCKET_DIRECTORY "bmwlauncher-aa-margins-13006"
#define BM_SOCKET_BASE BM_SOCKET_PARENT "/" BM_SOCKET_DIRECTORY
#define BM_PROTOCOL_VERSION 3
#define BM_MARKER "javi-aa-format/1.0.0"
#define BM_CLIENT_IDLE_MS 2000
static inline int bm_profile_parent(uint32_t mode, uint32_t uid, uint32_t gid) {
    return (mode & 0170000u) == 0040000u && (mode & 07777u) == 01777u &&
           uid == 0 && gid == 0;
}
static inline int bm_profile_identity(uint32_t ruid, uint32_t euid, uint32_t suid,
                                      uint32_t rgid, uint32_t egid, uint32_t sgid) {
    return ruid == BM_DAEMON_UID && euid == BM_DAEMON_UID && suid == BM_DAEMON_UID &&
           rgid == BM_DAEMON_GID && egid == BM_DAEMON_GID && sgid == BM_DAEMON_GID;
}
static inline int bm_profile_directory(uint32_t mode, uint32_t uid, uint32_t gid) {
    /* Serialized Linux mode bits, also used by portable policy tests. */
    return (mode & 0170000u) == 0040000u && (mode & 07777u) == 0700u &&
           uid == BM_DAEMON_UID && gid == BM_DAEMON_GID;
}
static inline int bm_profile_peer(uint32_t uid) { return uid == 0; }
#endif
