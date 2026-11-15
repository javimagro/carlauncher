/* SPDX-License-Identifier: MIT. Identity and filesystem permission policy. */
#include "bridge-profile.h"
#include <stdio.h>
static unsigned checks, failures;
#define CHECK(x) do { ++checks; if (!(x)) { ++failures; \
    fprintf(stderr, "profile line %d: %s\n", __LINE__, #x); } } while (0)
int profile_tests(void) {
    const uint32_t uid = BM_DAEMON_UID, gid = BM_DAEMON_GID;
    CHECK(bm_profile_identity(uid, uid, uid, gid, gid, gid));
    CHECK(!bm_profile_identity(0, 0, 0, 0, 0, 0));
    CHECK(!bm_profile_identity(uid + 1, uid, uid, gid, gid, gid));
    CHECK(!bm_profile_identity(uid, 0, uid, gid, gid, gid));
    CHECK(!bm_profile_identity(uid, uid, 0, gid, gid, gid));
    CHECK(!bm_profile_identity(uid, uid, uid, gid + 1, gid, gid));
    CHECK(!bm_profile_identity(uid, uid, uid, gid, 0, gid));
    CHECK(!bm_profile_identity(uid, uid, uid, gid, gid, 0));
    CHECK(bm_profile_directory(0040700, uid, gid));
    CHECK(!bm_profile_directory(0040755, uid, gid));
    CHECK(!bm_profile_directory(0040770, uid, gid));
    CHECK(!bm_profile_directory(0041700, uid, gid));
    CHECK(!bm_profile_directory(0042700, uid, gid));
    CHECK(!bm_profile_directory(0100700, uid, gid));
    CHECK(!bm_profile_directory(0120700, uid, gid));
    CHECK(!bm_profile_directory(0040700, 0, gid));
    CHECK(!bm_profile_directory(0040700, uid, 0));
    CHECK(!bm_profile_directory(0040700, uid + 1, gid));
    CHECK(bm_profile_peer(0));
    CHECK(!bm_profile_peer(uid));
    CHECK(!bm_profile_peer(uid + 1));
    CHECK(bm_profile_parent(0041777, 0, 0));
    CHECK(!bm_profile_parent(0040777, 0, 0));
    CHECK(!bm_profile_parent(0041777, uid, 0));
    CHECK(!bm_profile_parent(0041777, 0, gid));
    CHECK(!bm_profile_parent(0121777, 0, 0));
    CHECK(!bm_profile_parent(0043777, 0, 0));
    printf("Service profile: %u checks, %u failures (UID=%u GID=%u)\n",
           checks, failures, uid, gid);
    return failures != 0;
}
