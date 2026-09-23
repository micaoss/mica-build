#!/usr/bin/env bash
# src/rootfs/resolve.ts (src/cli.ts resolve), driven over the boards, radios and
# features this repository actually supports.
#
# Three things are asserted and the third is the one that is easy to skip:
#
#   1. THE RESOLVED SETS, for every board, and for a build that
#      declines every feature. Written out literally: a test that recomputed the
#      answer from the manifests would agree with any manifest at all.
#   2. EVERY REFUSAL, each proven RED BY MUTATION. A copy of the manifest tree
#      is made under tmp/, perturbed there, and the refusal is required to fire
#      on the copy and NOT on the pristine one -- a negative test whose removal
#      changes nothing is not a test. Each is matched on a FRAGMENT of its
#      message and not on the exit status alone, because a perturbed tree is
#      usually true of more than one refusal at once; and every fragment is then
#      required to be absent from all the other refusals' messages, so a
#      fragment that stopped discriminating fails here rather than silently
#      accepting whichever refusal happened to fire.
#   3. THE REVERSE DIRECTION: every package every producer declares has to be
#      reachable by SOME legal resolution. A package no manifest can ever name
#      is a package the composer will never install, and nothing else in this
#      repository would notice -- every check downstream of composition runs
#      over the set that WAS installed. Both counts are printed and a zero on
#      either side fails.
#
# No docker, no build, no pool: this reads manifests and the pins (src/cli.ts pool rows).
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
export LC_ALL=C

PACKAGES_DIR="${REPO_ROOT}/rootfs/packages"
# The boards' own manifests come out of the fetched bundles (make
# board-fetch-all); a board's --board-dir is its manifests/ there, or a
# perturbed copy of it under the scratch directory.
BOARDS_OUT="${REPO_ROOT}/_out/boards"
bd() { printf '%s' "${BOARDS_OUT}/$1/manifests"; }
# tmp/ and not /tmp: the repository-local scratch, per .gitignore.
SCRATCH="${REPO_ROOT}/tmp/rootfs-manifest-test.$$"
mkdir -p "${SCRATCH}"
trap 'rm -rf "${SCRATCH}"' EXIT

PASS_N=0
FAIL_N=0
pass() {
    PASS_N=$((PASS_N + 1))
    echo "PASS: $1"
}
fail() {
    FAIL_N=$((FAIL_N + 1))
    echo "FAIL: $1"
}

resolve_out=""
resolve_err=""
resolve_rc=0
# Runs the resolver over a NAMED manifest directory (--packages-dir), so the same
# call drives the tracked manifests and a perturbed copy of them against the same
# producers.
run_resolve() {
    local dir="$1"
    shift
    local errfile="${SCRATCH}/stderr"
    resolve_out=""
    resolve_rc=0
    if resolve_out="$(bash "${REPO_ROOT}/bin/bun.sh" src/cli.ts resolve --packages-dir "${dir}" "$@" 2>"${errfile}")"; then
        resolve_rc=0
    else
        resolve_rc=$?
    fi
    resolve_err="$(cat "${errfile}")"
    rm -f "${errfile}"
    # The directory is what differs between the pristine tree and each copy, so
    # it is normalised out before the messages are compared to each other.
    resolve_err="${resolve_err//${dir}/<MANIFESTS>}"
}

REFUSAL_LABELS=()
REFUSAL_TOKENS=()
REFUSAL_TEXTS=()
# label, the fragment the message must carry, manifest dir, args.
#
# Matching the MESSAGE and not only the exit status is the point: a refusal that
# fired for an unrelated reason is not the refusal under test, and every fault
# here is reachable from a tree in which some OTHER fault is also true. The
# fragments are held to their own standard below -- each has to be absent from
# every other refusal's message -- so a fragment that stopped discriminating
# turns this file red rather than quietly accepting the wrong refusal.
expect_refusal() {
    local label="$1" token="$2" dir="$3"
    shift 3
    run_resolve "${dir}" "$@"
    if [ "${resolve_rc}" -eq 0 ]; then
        fail "${label}: the resolver SUCCEEDED where it had to refuse. It printed: $(printf '%s' "${resolve_out}" | tr '\n' ' ')"
        return
    fi
    if [ "${resolve_err}" = "${resolve_err/${token}/}" ]; then
        fail "${label}: refused, but with a message that does not carry '${token}', so this is some OTHER refusal firing: ${resolve_err}"
        return
    fi
    REFUSAL_LABELS+=("${label}")
    REFUSAL_TOKENS+=("${token}")
    REFUSAL_TEXTS+=("${resolve_err}")
    pass "${label}: refused, naming '${token}'"
}

expect_set() {
    local label="$1" want="$2" dir="$3"
    shift 3
    run_resolve "${dir}" "$@"
    if [ "${resolve_rc}" -ne 0 ]; then
        fail "${label}: the resolver refused a legal resolution: ${resolve_err}"
        return
    fi
    local got
    got="$(printf '%s' "${resolve_out}" | tr '\n' ' ')"
    got="${got% }"
    if [ "${got}" = "${want}" ]; then
        pass "${label}: ${got}"
    else
        fail "${label}: resolved [${got}], expected [${want}]"
    fi
}

# ---------------------------------------------------------------------------
# 1. The resolved sets.
# ---------------------------------------------------------------------------

# The radios are read HERE and passed in, exactly as src/rootfs/build.ts does
# it: the resolver takes its inputs as arguments and re-derives none of them, so
# this test stands in for the driver rather than letting the resolver read the
# board file behind it.
# The features a product selects, read through src/product/product.ts, the one
# reader of products/<name>/product.env.
product_features() {
    bash "${REPO_ROOT}/bin/bun.sh" src/cli.ts product "$1" | sed -n 's/^FEATURES="\(.*\)"$/\1/p'
}
CX_FEATURES="$(product_features cx3576-dev)"
X64_FEATURES="$(product_features uefi-x64-dev)"
VIRT_ARM64_FEATURES="$(product_features uefi-arm64-dev)"

# mica-busybox is in EVERY set below, including CX_MINIMAL, and that is what
# rootfs/packages/common.pkgs holding it means: the emergency binary is not
# declinable, because the build that declined it is the image an operator is
# holding when they need it (RFCT-281).
CX_DEV="mica-apid mica-bluetooth mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-system mica-wifi mica-wifi-ap micad"
# Kernel and module payloads are independent of every user-space root.
X64_DEV="mica-apid mica-board-uefi-x64 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-system micad"
# uefi-arm64 is uefi-x64's set with its own board and kernel packages: the two
# boards differ in architecture and firmware, not in what userland the image
# carries, and BOARD_RADIOS is empty on both. Spelled out rather than derived
# from X64_DEV by substitution -- a set computed from another set agrees with
# it by construction and would not notice the day they stop agreeing.
VA_DEV="mica-apid mica-board-uefi-arm64 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-system micad"
CX_MINIMAL="mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-sftp-server mica-system"

expect_set "cx3576-dev: features '${CX_FEATURES}'" "${CX_DEV}" \
    "${PACKAGES_DIR}" --board cx3576 --board-dir "$(bd cx3576)" --features "${CX_FEATURES}"
expect_set "uefi-x64-dev: features '${X64_FEATURES}'" "${X64_DEV}" \
    "${PACKAGES_DIR}" --board uefi-x64 --board-dir "$(bd uefi-x64)" --features "${X64_FEATURES}"
expect_set "uefi-arm64-dev: features '${VIRT_ARM64_FEATURES}'" "${VA_DEV}" \
    "${PACKAGES_DIR}" --board uefi-arm64 --board-dir "$(bd uefi-arm64)" --features "${VIRT_ARM64_FEATURES}"

# A radio-less board carries no OTHER board's package and no radio package.
# Asserted as its own check and not left to the literals above, because the
# failure it guards against -- one board's packages leaking into another
# board's image -- is one an updated expectation would absorb without anyone
# reading it.
#
# Run over BOTH radio-less boards. With one board it could not distinguish
# "the resolver keeps boards apart" from "uefi-x64 happens to be the one the
# resolver was written around", and uefi-arm64 is the second board with an
# empty BOARD_RADIOS.
for va_pair in "uefi-x64:${X64_FEATURES}" "uefi-arm64:${VIRT_ARM64_FEATURES}"; do
    va_board="${va_pair%%:*}"
    va_features="${va_pair#*:}"
    run_resolve "${PACKAGES_DIR}" --board "${va_board}" --board-dir "$(bd "${va_board}")" --features "${va_features}"
    leaked=""
    for pkg in ${resolve_out}; do
        case "${pkg}" in
        mica-wifi | mica-wifi-ap | mica-bluetooth) leaked="${leaked}${pkg} " ;;
        mica-board-*)
            [ "${pkg}" = "mica-board-${va_board}" ] || leaked="${leaked}${pkg} " ;;
        esac
    done
    if [ -z "${leaked}" ]; then
        pass "${va_board} dev carries no other board package and no radio package"
    else
        fail "${va_board} dev carries foreign content: ${leaked% }. Its product selects no radio and it has its own board package"
    fi
done

# Selecting ONE radio leaves the other out: wifi and bluetooth are independent
# features, which is the whole point of the split -- the retired umbrella
# token carried both together.
CX_NO_BT="mica-apid mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-system mica-wifi mica-wifi-ap micad"
CX_NO_WIFI="mica-apid mica-bluetooth mica-board-cx3576 mica-busybox mica-ca-trust mica-deploy mica-mqtt-broker mica-mqttd mica-podman mica-sftp-server mica-system micad"
expect_set "cx3576 dev, features without bluetooth keep Wi-Fi" "${CX_NO_BT}" \
    "${PACKAGES_DIR}" --board cx3576 --board-dir "$(bd cx3576)" --features "micad mqtt containers wifi"
expect_set "cx3576 dev, features without wifi keep Bluetooth" "${CX_NO_WIFI}" \
    "${PACKAGES_DIR}" --board cx3576 --board-dir "$(bd cx3576)" --features "micad mqtt containers bluetooth"
# The umbrella token is GONE, not quietly tolerated: a caller still passing
# --without radios gets the unknown-feature refusal instead of a build that
# happens to keep both radios.
run_resolve "${PACKAGES_DIR}" --board cx3576 --board-dir "$(bd cx3576)" --features "radios"
if [ "${resolve_rc}" -ne 0 ]; then
    pass "--features radios is refused: the umbrella token no longer exists"
else
    fail "--features radios still resolves; the umbrella token was to be removed with the producer split"
fi

# Declining every feature drops exactly the feature packages and leaves a legal
# image set: common and one board. No product declares it any more (the minimal
# products were removed, user 2026-09-16), so this is where the floor is proved.
expect_set "the floor on cx3576: --features ''" "${CX_MINIMAL}" \
    "${PACKAGES_DIR}" --board cx3576 --board-dir "$(bd cx3576)" --features ""
dropped=""
for pkg in ${CX_DEV}; do
    case " ${CX_MINIMAL} " in
    *" ${pkg} "*) ;;
    *) dropped="${dropped}${pkg} " ;;
    esac
done
want_dropped="mica-apid mica-bluetooth mica-mqtt-broker mica-mqttd mica-podman mica-wifi mica-wifi-ap micad"
if [ "${dropped% }" = "${want_dropped}" ]; then
    pass "the floor leaves out exactly: ${want_dropped}"
else
    fail "the floor left out [${dropped% }], expected [${want_dropped}]"
fi
# Every other board's floor composes too, which is what the minimal products used to prove.
for b in $(bash bin/bun.sh src/cli.ts boards list); do
    [ "${b}" != cx3576 ] || continue
    run_resolve "${PACKAGES_DIR}" --board "${b}" --board-dir "$(bd "${b}")" --features ""
    if [ "${resolve_rc}" -eq 0 ]; then
        pass "the floor composes on ${b} with no feature"
    else
        fail "the floor does not compose on ${b}: ${resolve_out}"
    fi
done

# ---------------------------------------------------------------------------
# 2. The refusals, each proven red by mutation.
# ---------------------------------------------------------------------------

# A copy of the manifest tree that nothing perturbs. Every mutation below is
# measured against it: the refusal has to fire on the perturbed copy and stay
# silent on this one, or the mutation proved nothing.
PRISTINE="${SCRATCH}/pristine"
cp -a "${PACKAGES_DIR}" "${PRISTINE}"
expect_set "the pristine copy under tmp/ resolves identically to the tracked tree" "${CX_DEV}" \
    "${PRISTINE}" --board cx3576 --board-dir "$(bd cx3576)" --features "${CX_FEATURES}"

mutate() {
    local name="$1"
    local dir="${SCRATCH}/${name}"
    rm -rf "${dir}"
    cp -a "${PACKAGES_DIR}" "${dir}"
    printf '%s' "${dir}"
}
# A perturbed copy of one board's manifests, for the refusals that live on
# the board's side of the resolution.
mutate_board() {
    local name="$1" board="$2"
    local dir="${SCRATCH}/${name}-${board}"
    rm -rf "${dir}"
    cp -a "$(bd "${board}")" "${dir}"
    printf '%s' "${dir}"
}

# (a) an unknown feature name in --without.
expect_refusal "unknown feature in --features" "zigbee" "${PACKAGES_DIR}" \
    --board cx3576 --board-dir "$(bd cx3576)" --features "${CX_FEATURES} zigbee"
run_resolve "${PACKAGES_DIR}" --board cx3576 --board-dir "$(bd cx3576)" --features "micad containers wifi bluetooth"
if [ "${resolve_rc}" -eq 0 ]; then
    pass "a legal feature list does not trip the unknown-feature refusal"
else
    fail "a feature list without mqtt was refused on the tracked tree: ${resolve_err}"
fi
# The mutation runs the other way for this one, and it is the stronger
# direction: a NEW feature manifest makes a previously illegal name legal, which
# a hardcoded list of features could not do.
dir="$(mutate feature-added)"
printf '# scratch mutation\nmica-mqttd\n' >"${dir}/feature-zigbee.pkgs"
run_resolve "${dir}" --board cx3576 --board-dir "$(bd cx3576)" --features "${CX_FEATURES} zigbee"
if [ "${resolve_rc}" -eq 0 ]; then
    pass "adding feature-zigbee.pkgs to a copy makes --features zigbee legal there: the feature list is read from the tree"
else
    fail "feature-zigbee.pkgs was added to a copy and --without zigbee was still refused, so the feature list does not come from the manifests: ${resolve_err}"
fi

# (b) a manifest line naming a package no producer declares.
dir="$(mutate undeclared-package)"
printf 'mica-not-a-real-package\n' >>"${dir}/common.pkgs"
expect_refusal "manifest names a package no producer declares" "mica-not-a-real-package" "${dir}" \
    --board cx3576 --board-dir "$(bd cx3576)" --features "${CX_FEATURES}"

# (c) the image profile is not a resolver input: it selects no package.
run_resolve "${PACKAGES_DIR}" --board cx3576 --board-dir "$(bd cx3576)" --profile dev --features "${CX_FEATURES}"
if [ "${resolve_rc}" -ne 0 ]; then
    pass "--profile is refused: the image profile selects no package"
else
    fail "--profile still resolves; the profile was to stop selecting packages"
fi

# (d) an empty resolution, and one with no board package.
#
# The fragment matters more here than anywhere else: an empty resolution also
# carries no board package, so both refusals are
# true of this tree and only the first one to run says the useful thing. With a
# bare exit-status assertion, deleting the emptiness check entirely would leave
# this test green.
dir="$(mutate empty-resolution)"
for f in "${dir}"/*.pkgs; do : >"${f}"; done
bdir="$(mutate_board empty-resolution cx3576)"
for f in "${bdir}"/*.pkgs; do : >"${f}"; done
expect_refusal "empty resolution" "is EMPTY" "${dir}" \
    --board cx3576 --board-dir "${bdir}" --features "${CX_FEATURES}"

bdir="$(mutate_board no-board-package cx3576)"
: >"${bdir}/board.pkgs"
expect_refusal "resolution carries no board package" "NO board package" "${PACKAGES_DIR}" \
    --board cx3576 --board-dir "${bdir}" --features "${CX_FEATURES}"

# (e) a board manifest in the engine's directory, and a board bundle with no
# board.pkgs: the two halves of the split, each refused by name.
dir="$(mutate board-manifest-in-engine)"
printf 'mica-board-cx3576\n' >"${dir}/board-cx3576.pkgs"
expect_refusal "a board manifest in the engine directory" "board manifest in the engine" "${dir}" \
    --board cx3576 --board-dir "$(bd cx3576)" --features "${CX_FEATURES}"
bdir="$(mutate_board no-board-manifest cx3576)"
rm -f "${bdir}/board.pkgs"
expect_refusal "a board bundle with no board.pkgs" "no board.pkgs" "${PACKAGES_DIR}" \
    --board cx3576 --board-dir "${bdir}" --features "${CX_FEATURES}"

REFUSAL_N="${#REFUSAL_LABELS[@]}"
[ "${REFUSAL_N}" -gt 0 ] || {
    echo "error: not one refusal was recorded, so the two checks below compare nothing against nothing" >&2
    exit 1
}

# Every refusal must have its OWN message. One message covering two faults tells
# an operator that something is wrong and not which thing.
# Counted as whole texts: a refusal can run to several lines, and a shared
# trailing note would otherwise make two refusals look alike.
distinct_n="$(printf '%s\0' "${REFUSAL_TEXTS[@]}" | sort -zu | tr -cd '\0' | wc -c)"
if [ "${distinct_n}" -eq "${REFUSAL_N}" ]; then
    pass "${REFUSAL_N} refusals, ${distinct_n} distinct messages"
else
    fail "${REFUSAL_N} refusals produced only ${distinct_n} distinct messages; at least two faults share one message"
fi

# And every fragment matched above must be absent from every OTHER refusal's
# message. Without this, a fragment could match all six and each expect_refusal
# would be asserting nothing beyond a non-zero exit.
cross_n=0
shared=""
for ((i = 0; i < REFUSAL_N; i++)); do
    for ((j = 0; j < REFUSAL_N; j++)); do
        [ "${i}" -ne "${j}" ] || continue
        cross_n=$((cross_n + 1))
        if [ "${REFUSAL_TEXTS[j]}" != "${REFUSAL_TEXTS[j]/${REFUSAL_TOKENS[i]}/}" ]; then
            shared="${shared}'${REFUSAL_TOKENS[i]}' (${REFUSAL_LABELS[i]}) also appears in the message for ${REFUSAL_LABELS[j]}; "
        fi
    done
done
if [ -z "${shared}" ]; then
    pass "each of the ${REFUSAL_N} fragments appears in its own refusal and in none of the others (${cross_n} comparisons)"
else
    fail "a refusal fragment does not discriminate: ${shared}"
fi

# ---------------------------------------------------------------------------
# 3. The reverse direction: every declared package reachable.
# ---------------------------------------------------------------------------

# Packages that NO legal resolution can name, with the reason each is exempt.
# A written list rather than a tolerance: a package
# that quietly stops being reachable is a package the composer stops installing,
# and every check downstream of composition would keep passing over the smaller
# image.
declare -A UNREACHABLE_OK=(
    [mica-lifecycle]="mica-runkit is taken out of the archive by tools/deploy-pool.sh --lifecycle into the image's own root, never installed by APT"
    [mica-systemd-boot]="the unsigned systemd-boot loader boot/build-tools.sh signs into the firmware component, never installed into a root"
)

DECLARED=""
DECLARED_N=0

# The lock's rows are the declared packages: what locks/ imports is
# what the composer installs, exactly as the resolver counts it. Each arch has a
# row, so a package is counted once.
LOCK_ROWS="$(bash "${REPO_ROOT}/bin/bun.sh" src/cli.ts pool rows)"
while IFS=$'\t' read -r pkg _rest; do
    [ -n "${pkg}" ] || continue
    case " ${DECLARED} " in
    *" ${pkg} "*) ;;
    *)
        DECLARED="${DECLARED}${pkg} "
        DECLARED_N=$((DECLARED_N + 1))
        ;;
    esac
done <<<"${LOCK_ROWS}"

# The legal space, taken from the manifest tree and the board files rather than
# from a list written here: a board, radio or feature added to the
# repository is enumerated by this check the day it lands.
mapfile -t ALL_BOARDS < <(bash "${REPO_ROOT}/bin/bun.sh" src/cli.ts boards list)
mapfile -t ALL_FEATURES < <(
    cd "${PACKAGES_DIR}" && for f in feature-*.pkgs; do basename "${f}" .pkgs | sed 's/^feature-//'; done
    cd "${PACKAGES_DIR}" && for f in radio-*.pkgs; do basename "${f}" .pkgs | sed 's/^radio-//'; done
)
mapfile -t ALL_FEATURES < <(printf '%s\n' "${ALL_FEATURES[@]}" | sort -u)

REACHED=""
RESOLUTIONS_N=0
board_takes() { # board feature: a hardware feature the board declares, or a software one
    local hw="wifi bluetooth display status-led can usb-gadget audio containers" have
    case " ${hw} " in *" $2 "*) ;; *) return 0 ;; esac
    have="$(sed -n 's/^BOARD_FEATURES="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' "${BOARDS_OUT}/$1/board.env" | sed -n '1p')"
    case " ${have} " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}
for board in "${ALL_BOARDS[@]}"; do
    # The features this board can take: the legal space is their power set.
    BOARD_FEATURE_LIST=()
    for f in "${ALL_FEATURES[@]}"; do board_takes "${board}" "${f}" && BOARD_FEATURE_LIST+=("${f}"); done
    feat_n="${#BOARD_FEATURE_LIST[@]}"
    # The full power set of the board's features, not just "select all".
    # "Select all" alone would prove reachability just as well, and would
    # also pass over a resolver that ignored --features entirely.
    for ((mask = 0; mask < (1 << feat_n); mask++)); do
        features=""
        for ((i = 0; i < feat_n; i++)); do
            if (((mask >> i) & 1)); then features="${features}${BOARD_FEATURE_LIST[i]} "; fi
        done
        run_resolve "${PACKAGES_DIR}" --board "${board}" --board-dir "$(bd "${board}")" \
            --features "${features% }"
        if [ "${resolve_rc}" -ne 0 ]; then
            fail "reachability: --board ${board} --features '${features% }' was refused, and every one of these is a legal build: ${resolve_err}"
            continue
        fi
        RESOLUTIONS_N=$((RESOLUTIONS_N + 1))
        for pkg in ${resolve_out}; do
            case " ${REACHED} " in
            *" ${pkg} "*) ;;
            *) REACHED="${REACHED}${pkg} " ;;
            esac
        done
    done
done

# Optional board components must also be reachable through their explicit selection.
for board in "${ALL_BOARDS[@]}"; do
    for file in "$(bd "$board")"/component-*.pkgs; do
        [ -f "$file" ] || continue
        component=${file##*/component-}; component=${component%.pkgs}
        run_resolve "$PACKAGES_DIR" --board "$board" --board-dir "$(bd "$board")" \
            --features "$(product_features "${board}-dev")" --components "$component"
        if [ "$resolve_rc" -ne 0 ]; then
            fail "component $board/$component is unreachable: $resolve_err"
        else
            REACHED="$REACHED $resolve_out"
            RESOLUTIONS_N=$((RESOLUTIONS_N + 1))
        fi
    done
done

REACHED=$(printf '%s\n' $REACHED | sort -u | tr '\n' ' ')
REACHED_N=0
for _pkg in ${REACHED}; do REACHED_N=$((REACHED_N + 1)); done

echo "COUNTS: ${DECLARED_N} packages declared by producers and the lock, ${REACHED_N} proven reachable, over ${RESOLUTIONS_N} legal resolutions (${#ALL_BOARDS[@]} boards x their feature subsets)"
[ "${DECLARED_N}" -gt 0 ] || {
    echo "error: neither the producers nor the lock declared a package, so the reachability check would have compared nothing against nothing and passed" >&2
    exit 1
}
[ "${REACHED_N}" -gt 0 ] || {
    echo "error: no package was reached by any resolution, so the reachability check would have found every declared package unreachable or -- with an empty declared set -- nothing at all" >&2
    exit 1
}
[ "${RESOLUTIONS_N}" -gt 0 ] || {
    echo "error: no legal resolution was enumerated; the union above is the union of nothing" >&2
    exit 1
}

for pkg in ${DECLARED}; do
    case " ${REACHED} " in
    *" ${pkg} "*)
        pass "reachable: ${pkg}"
        continue
        ;;
    esac
    if [ -n "${UNREACHABLE_OK[${pkg}]:-}" ]; then
        pass "unreachable by design: ${pkg} -- ${UNREACHABLE_OK[${pkg}]}"
    else
        fail "${pkg} is declared by a producer and NO legal resolution names it. The composer will never install it, and no check downstream of composition can see that: they all run over the set that was installed. Name it in a manifest, or list it in UNREACHABLE_OK in this file with the reason"
    fi
done
# A stale exemption is an exemption that hides the next regression.
for pkg in "${!UNREACHABLE_OK[@]}"; do
    case " ${REACHED} " in
    *" ${pkg} "*)
        fail "${pkg} is listed in UNREACHABLE_OK but a legal resolution does name it. Remove the exemption; while it stands, this package's reachability is asserted by nothing"
        ;;
    esac
done

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) ($((PASS_N))/$((PASS_N + FAIL_N)) checks passed, ${DECLARED_N} packages declared, ${REACHED_N} reachable, ${RESOLUTIONS_N} resolutions, ${REFUSAL_N} refusals)"
[ "${FAIL_N}" -eq 0 ]
