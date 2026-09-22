#!/usr/bin/env bash
# The kernel symbols netavark needs, asserted against every board's config.
#
#   bash tests/gates/netavark-kernel-config-test.sh
#
# WHY THIS FILE EXISTS. podman bridge networking on cx3576 was unusable because
# the board kernel was built with `# CONFIG_NFT_FIB_IPV4 is not set`, the same
# for IPV6, and CONFIG_NFT_FIB_INET absent entirely. netavark opens its
# port-forwarding path with `fib daddr type local jump <dnat_chain>` in the
# prerouting and output chains of its inet table; on a kernel with no fib
# expression that rule cannot be programmed, so setup_network fails and every
# container on a bridge network fails with it. Nothing in this repository
# required those symbols, so the gap was invisible to every gate: the board
# config said "not set", and that was simply accepted.
#
# WHAT IS PROVED HERE, AND WHAT IS NOT. This reads the COMMITTED configs, which
# are build inputs, not outputs. `make olddefconfig` runs after them and can
# still drop a symbol whose dependencies are unmet -- silently, because a
# dropped symbol simply is not in the output. That direction is proved by the
# post-olddefconfig grep loops in each board's kernel CONFIGURE STEP. Assertion 2
# below therefore requires every symbol in this list to be named by one of those
# loops: two lists free to disagree are one list that is not enforced, and the
# built config is the only one the hardware ever sees.
#
# WHERE THAT STEP LIVES IS PER BOARD, which is why the rows below name a file
# each rather than deriving one. uefi-x64 and uefi-arm64 still run it inside their
# kernel Dockerfile; cx3576's moved to mica-boards:cx3576/bsp/kernel/configure.sh
# under RFCT-345, when that board's build logic came out of its Dockerfile. It is
# the same loop and this file reads it the same way -- a row still pointing at
# the Dockerfile after the move would have found no `for option in` and no
# fragment, and refused by name, which is the behaviour that matters.
#
# THOSE LOOPS FAIL THE KERNEL BUILD, NOT THE IMAGE BUILD, and the difference is
# what RFCT-343 found. `_out/boards/<board>/kernel/` is an INPUT to image assembly: a tree
# that already has one does not rebuild it, so neither this file nor those loops
# runs, and both stay green over a kernel compiled before the fragment they are
# checking. Measured on cx3576 -- an Image from 2026-08-31 rode every image built
# for the next week while the fragment gained dm-crypt, the eBPF/firewall/bridge
# floor and NF_CONNTRACK_MARK/NF_NAT_MASQUERADE.
#
# *** THERE IS NO SECOND END FOR THESE SYMBOLS, AND THIS PARAGRAPH USED TO SAY
# THERE WAS. *** It named src/verify/checks-kernel.ts as the half that reads the
# `/boot/config-*` an image actually ships. THAT FILE WAS DELETED ON 2026-09-09
# IN 1875d133 -- 748 lines, alongside checks-display.ts, in a commit whose
# message calls it "unused layout code" -- and nothing replaced it. The only
# places that read a shipped kernel config today are src/image/kernel-package.ts
# and stages/compose/compose-install.sh, AND BOTH ARE ABOUT BOOT AND VERITY:
# DM_INIT, BLK_DEV_DM, DM_VERITY, SQUASHFS. No gate in this repository asserts a
# netavark symbol, a container-limit symbol, or anything else from
# mica-boards common/kernel/mica-required.fragment against a shipped artefact.
#
# SO FOR THESE SYMBOLS THE COMMITTED INPUTS ARE THE ONLY END, which is exactly
# why the stale-`_out` hazard described above escapes everything: the paragraph
# describing the hazard was also the paragraph claiming it was covered. The
# deleted file had its own copy of the symbol list, so restoring it verbatim
# would reintroduce a private copy of mica-boards' floor; the repair needs one
# source for the list, and that is an open proposal rather than a thing this
# comment may assert.
#
# EVERY BOARD, since PLAN-074. uefi-x64 used to be out of scope because it ran
# Debian's kernel, where these are modules the distribution ships and nothing in
# this tree chose the .config. It builds its own now, so its committed config is
# read here too -- and the symbols themselves moved into
# mica-boards common/kernel/mica-required.fragment, which both boards merge before
# olddefconfig and both assert afterwards. That is what assertion 2 accepts as
# the gate: the board's own loop, or the shared fragment both loops enforce.
#
# WHERE THE LIST COMES FROM. Every entry cites a line of netavark that programs
# the rule needing it, read from the tag mica-podman:upstream.lock pins.
# Assertion 3 requires that pin to still be the version the citations were read
# against -- a citation into a version nobody ships is decoration.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
# One row per board: the committed config a build starts from, and the file that
# asserts the result after olddefconfig. Discovered from neither -- written here,
# because a board with no kernel build has no row and a glob would give it one.
# Every board the lock pins, and the BUILT config its board artifact carries
# (tools/board-pool.sh --fetch extracted it; a FIT board has one per profile).
# Not the committed config: the assembly no longer holds a board's kernel
# tree, and what it ships is the built one.
BOARD_CONFIGS=""
for b in $(bash "${REPO_ROOT}/tools/board-pool.sh" --list); do
    for profile in dev prod; do
        dir="$(bash "${REPO_ROOT}/tools/board-pool.sh" --kernel-dir "${b}" "${profile}")"
        case " ${BOARD_CONFIGS} " in *":${dir#"${REPO_ROOT}"/}/config "*) continue ;; esac
        BOARD_CONFIGS="${BOARD_CONFIGS}${b}:${dir#"${REPO_ROOT}"/}/config "
    done
done
# The one shared fragment every board's kernel build merges, of this tree.
FRAGMENTS="${REPO_ROOT}/common/kernel/mica-required.fragment "
PODMAN_LOCK="${REPO_ROOT}/_out/debs/mica-podman/upstream.lock"

# The netavark the citations below were read against.
CITED_NETAVARK=v2.1.0

# SYMBOL and the netavark line that needs it. Paths are relative to the netavark
# source tree at ${CITED_NETAVARK}.
#
# The inet family is what makes the fib entries the ones that were missing:
# netavark puts every chain in one inet table, so its fib lookup is the inet one,
# and NFT_FIB_INET depends on BOTH address families being built (6.1
# net/netfilter/Kconfig: `depends on NFT_FIB_IPV4`, `depends on NFT_FIB_IPV6`),
# each of which selects the shared NFT_FIB core.
REQUIRED=$(cat <<'LIST'
VETH               src/network/bridge.rs:937,945 CreateLinkOptions::new(.., InfoKind::Veth) -- the container/host veth pair
BRIDGE             src/network/bridge.rs:832 InfoKind::Bridge -- the network's bridge link
NF_TABLES          src/firewall/nft.rs:70 NfListObject::Table -- netavark 2.x programs nftables and ships no iptables driver
NF_TABLES_INET     src/firewall/nft.rs:72 family: NfFamily::INet -- one inet table holds every chain
NF_TABLES_IPV4     src/firewall/nft.rs:455 NATFamily::IP -- the IPv4 half of that inet table
NF_TABLES_IPV6     src/firewall/nft.rs:493 NATFamily::IP6 -- the IPv6 half of that inet table
NF_NAT             src/firewall/nft.rs:92,98,104 NfChainType::NAT on postrouting/prerouting/output
NFT_NAT            src/firewall/nft.rs:451,489 Statement::SNAT and 1101,1258 Statement::DNAT -- published ports
NFT_MASQ           src/firewall/nft.rs:160,473,511 Statement::Masquerade -- outbound container traffic
NF_NAT_MASQUERADE  src/firewall/nft.rs:160 the masquerade above; NFT_MASQ selects it
NF_CONNTRACK       src/firewall/nft.rs:246,560 ct state {invalid} and {established,related}
NFT_CT             src/firewall/nft.rs:246,560 the ct expression those rules match on
NF_CONNTRACK_MARK  src/firewall/nft.rs:286,1090 ct mark -- the dnat mark netavark sets and matches
NFT_FIB_IPV4       src/firewall/nft.rs:206 fib daddr type local -- the IPv4 lookup the inet fib delegates to
NFT_FIB_IPV6       src/firewall/nft.rs:206 fib daddr type local -- the IPv6 lookup the inet fib delegates to
NFT_FIB_INET       src/firewall/nft.rs:206 fib daddr type local, in an inet table: the expression itself
NFT_FIB            src/firewall/nft.rs:206 the shared fib core both address families select
LIST
)

PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

# The per-board files are checked inside the loops that read them, where a
# missing one can name its board. These are the two this file reads directly.
for f in ${FRAGMENTS} "${PODMAN_LOCK}"; do
    [ -f "${f}" ] || { echo "error: ${f} not found; there is nothing to check" >&2; exit 1; }
done

# A list that emptied itself would make every loop below report green without
# having compared anything.
mapfile -t SYMBOLS < <(awk 'NF {print $1}' <<<"${REQUIRED}")
[ "${#SYMBOLS[@]}" -ge 17 ] || {
    echo "error: the requirement list holds ${#SYMBOLS[@]} symbols; it held 17 when written." >&2
    echo "       Shrinking it is allowed, but not by accident -- move this floor with it." >&2
    exit 1
}

echo "--- 1. every symbol is =y in every board's committed config"
# =y and not =m: mica-boards common/kernel/mica-required.fragment states the rule -- a
# dm-verity root with no initramfs cannot load a module before the rootfs is up,
# and each board Dockerfile's own loop greps for =y for the same reason.
#
# A board whose committed config is the RESOLVED one (uefi-x64 records the result of
# merging the fragments over x86_64_defconfig) and one whose committed config is
# the vendor INPUT (cx3576) are read the same way here: in both, a line that is
# not `=y` is a build this tree agreed to make.
BOARDS_CHECKED=0
for row in ${BOARD_CONFIGS}; do
    board="${row%%:*}"
    cfg="${REPO_ROOT}/${row#*:}"
    [ -f "${cfg}" ] || {
        echo "error: ${row#*:} does not exist, so ${board}'s config would be checked by nothing." >&2
        exit 1
    }
    BOARDS_CHECKED=$((BOARDS_CHECKED + 1))
    while IFS= read -r line; do
        [ -n "${line}" ] || continue
        sym="${line%% *}"
        why="${line#"${sym}"}"
        why="${why#"${why%%[! ]*}"}"
        if grep -qx "CONFIG_${sym}=y" "${cfg}"; then
            pass "${board}: CONFIG_${sym}=y (${why})"
        else
            have="$(grep -E "^(CONFIG_${sym}=.*|# CONFIG_${sym} is not set)$" "${cfg}" || true)"
            fail "CONFIG_${sym} is not =y in ${cfg#"${REPO_ROOT}/"} (found: ${have:-nothing}). netavark needs it: ${why}"
        fi
    done <<<"${REQUIRED}"
done
[ "${BOARDS_CHECKED}" -ge 1 ] || {
    echo "error: no board config was read: locks/ has no board row, or no bundle was fetched (make os-netavark-kernel-test runs tools/board-pool.sh --kernels first)." >&2
    exit 1
}

echo
# --- 2. (the post-olddefconfig gate files are checked where the kernel trees
#        live: mica-boards common/kernel/kernel-config-test.sh)
echo "--- 3. the citations point at the netavark this tree ships"
pinned="$(awk -F'\t' '$1 == "git" && $2 == "netavark" { print $4 }' "${PODMAN_LOCK}")"
if [ "${pinned}" = "${CITED_NETAVARK}" ]; then
    pass "mica-podman:upstream.lock still pins netavark ${CITED_NETAVARK}"
else
    fail "mica-podman:upstream.lock pins netavark ${pinned:-nothing}, but the citations above were read from ${CITED_NETAVARK}. Re-read src/firewall/nft.rs at the new tag and move the list and CITED_NETAVARK together."
fi

echo
echo "--- 4. the shared floor and this list do not disagree about a symbol"
# Since the eBPF/firewall floor landed, mica-boards common/kernel/mica-required.fragment
# pins most of the list above =y for EVERY board. Two floors naming the same
# symbol are only safe while they agree: if the fragment ever stated one of
# these as =m or "is not set", cx3576 would still be green here -- the board
# Dockerfile's own loop covers it -- while every other board silently got the
# weaker answer. So each symbol the fragment mentions at all must be pinned
# there as =y. Symbols the fragment does not mention are this file's alone and
# are skipped, which is why the overlap is counted rather than assumed.
for fragment in ${FRAGMENTS}; do
    board=every-board
    OVERLAP_N=0
    for sym in "${SYMBOLS[@]}"; do
        stated="$(grep -E "^(CONFIG_${sym}=.*|# CONFIG_${sym} is not set)$" "${fragment}" || true)"
        [ -n "${stated}" ] || continue
        OVERLAP_N=$((OVERLAP_N + 1))
        if [ "${stated}" = "CONFIG_${sym}=y" ]; then
            pass "${board}: the shared fragment pins CONFIG_${sym}=y too"
        else
            fail "${board}: the shared fragment states CONFIG_${sym} as '${stated}', not =y. Every board merges that file, so a weaker statement there is a weaker floor everywhere except the board whose Dockerfile happens to re-assert it"
        fi
    done
    # The loop above is silent when the overlap is empty, and an empty overlap is
    # exactly what a moved or emptied fragment looks like from here.
    if [ "${OVERLAP_N}" -ge 15 ]; then
        pass "${board}: the two floors overlap on ${OVERLAP_N} symbols"
    else
        fail "${board}: only ${OVERLAP_N} of the ${#SYMBOLS[@]} symbols above are stated in ${fragment#"${REPO_ROOT}/"}; 15 were when this assertion was written. Shrinking the overlap is allowed, but not by accident -- move this floor with it"
    fi
done

echo
if [ "${FAIL_N}" -eq 0 ]; then
    echo "RESULT: PASS (${PASS_N}/${PASS_N} assertions)"
else
    echo "RESULT: FAIL (${FAIL_N} of $((PASS_N + FAIL_N)) assertions failed)"
    exit 1
fi
