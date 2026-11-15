/* SPDX-License-Identifier: MIT. Own ABI observations, 2026-11-15.
 * Observed declarations only, not a public Cinemo SDK contract.
 * See README.md and ABI.md for evidence and the pinned-profile boundary.
 * All RVAs below belong to the SHA-256 pinned ELF, before its load bias.
 */
#ifndef BMW_AA_MAIN_MARGINS_ABI_H
#define BMW_AA_MAIN_MARGINS_ABI_H

#include <stddef.h>
#include <stdint.h>

#if !defined(__linux__) || !defined(__x86_64__)
#error This observed ABI is Linux x86-64 SysV only.
#endif

#define BMW_AA_AAPD_SHA256 \
    "a7971d64fc0feb4e48942441dc76a67d6df282b56cb5d64e92248ff83f18d62e"
#define BMW_AA_LIBRARY_SHA256 \
    "10446b6de0d99272cc28d0e51e9afa0e2bbcbb40eef6c7ad688f1544857ef1ac"
#define BMW_AA_SDK_SHA256 \
    "0fa7e320d7bf223a3a8c9680c4a7c15a3a462e565f3774fee6c94a07b03bd4aa"
#define BMW_AA_BASE_CLASSES_SHA256 \
    "b4fd26751d34e5eff5d14f773bbcb4535b849dba88d549f54c889d96961c7e60"

/* Opaque interface pointers. Never substitute raw internal object addresses. */
struct bmw_aa_interface;
struct bmw_aa_display;

/* Present is a full 32-bit value (0 or 1), not C/C++ bool.
 * Native evidence: converters 0x83190/0x82c40 and BMW logger 0x35f3b0.
 */
struct bmw_aa_optional_u32 {
    uint32_t present;
    uint32_t value;
};
struct bmw_aa_insets {
    struct bmw_aa_optional_u32 top;
    struct bmw_aa_optional_u32 bottom;
    struct bmw_aa_optional_u32 left;
    struct bmw_aa_optional_u32 right;
};

/* Error/refcount results occupy EAX. Error signedness is not material for the
 * observed nonnegative codes; these typedefs are our contract, not SDK names.
 * Factory: RDI=out. GetDisplay: RDI=this, RSI=out, EDX=index.
 * Successful GetDisplay output already owns a reference for its native caller.
 */
typedef int32_t bmw_aa_result;
typedef bmw_aa_result (*bmw_aa_create_fn)(struct bmw_aa_interface **out);
typedef bmw_aa_result (*bmw_aa_get_display_fn)(
    struct bmw_aa_interface *self, struct bmw_aa_display **out, uint32_t index);
typedef uint32_t (*bmw_aa_ref_fn)(void *self);
typedef bmw_aa_result (*bmw_aa_set_margins_fn)(
    struct bmw_aa_display *self, const struct bmw_aa_insets *insets);
typedef bmw_aa_result (*bmw_aa_get_margins_fn)(
    struct bmw_aa_display *self, struct bmw_aa_insets *out);

enum {
    BMW_AA_MAIN_DISPLAY = 0,
    BMW_AA_SUCCESS = 0,
    BMW_AA_INVALID_ARGUMENT_OBSERVED = 11,
    BMW_AA_FAILURE_OBSERVED = 12,
    BMW_AA_NOT_READY_OBSERVED = 13,
    BMW_AA_MARGINS_UNAVAILABLE_OBSERVED = 118,

    BMW_AA_ADDREF_SLOT = 0,
    BMW_AA_RELEASE_SLOT = 1,
    BMW_AA_SET_CALLBACKS_SLOT = 6,      /* audio, core, video raw callback pointers */
    BMW_AA_GET_DISPLAY_SLOT = 18,       /* byte offset 0x90 */
    BMW_AA_SET_MARGINS_SLOT = 15,       /* display byte offset 0x78 */
    BMW_AA_GET_MARGINS_SLOT = 19,       /* display byte offset 0x98 */
    BMW_AA_PRIMARY_SLOTS = 55,
    BMW_AA_PRIMARY_PREFIX_WORDS = 2,
    BMW_AA_PRIMARY_CLONE_BYTES = 456,
    BMW_AA_CORE_CALLBACK_SLOTS = 12,
    BMW_AA_VIDEO_CALLBACK_SLOTS = 6,
    BMW_AA_CORE_BEGIN_SLOT = 3,
    BMW_AA_CORE_END_SLOT = 5,
    BMW_AA_VIDEO_CONFIG_SLOT = 2,
    BMW_AA_VIDEO_UI_SLOT = 5,

    BMW_AA_SDK_FACTORY_RVA = 0x9d560,
    BMW_AA_PRIMARY_VPTR_RVA = 0x3daf38,
    BMW_AA_PRIMARY_TYPEINFO_RVA = 0x3daad8,
    BMW_AA_GET_DISPLAY_RVA = 0x60cc0,
    BMW_AA_DISPLAY_VPTR_RVA = 0x3d81f8,
    BMW_AA_DISPLAY_ADDREF_RVA = 0x65180,
    BMW_AA_DISPLAY_RELEASE_RVA = 0x65280,
    BMW_AA_SET_MARGINS_RVA = 0x6abd0,
    BMW_AA_GET_MARGINS_RVA = 0x6c3c0
};

#if defined(__cplusplus)
#define BMW_AA_ASSERT(c, m) static_assert((c), m)
#else
#define BMW_AA_ASSERT(c, m) _Static_assert((c), m)
#endif
BMW_AA_ASSERT(sizeof(void *) == 8, "64-bit pointers required");
BMW_AA_ASSERT(sizeof(struct bmw_aa_optional_u32) == 8, "optional ABI");
BMW_AA_ASSERT(sizeof(struct bmw_aa_insets) == 32, "Insets ABI");
BMW_AA_ASSERT(offsetof(struct bmw_aa_insets, top) == 0, "top ABI");
BMW_AA_ASSERT(offsetof(struct bmw_aa_insets, bottom) == 8, "bottom ABI");
BMW_AA_ASSERT(offsetof(struct bmw_aa_insets, left) == 16, "left ABI");
BMW_AA_ASSERT(offsetof(struct bmw_aa_insets, right) == 24, "right ABI");
BMW_AA_ASSERT((BMW_AA_PRIMARY_SLOTS + BMW_AA_PRIMARY_PREFIX_WORDS) * 8 ==
              BMW_AA_PRIMARY_CLONE_BYTES, "primary vtable extent");
#undef BMW_AA_ASSERT

#endif
