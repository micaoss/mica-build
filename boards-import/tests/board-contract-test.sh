#!/usr/bin/env bash
# The board bundle contract (mica:docs/boards/contract.md, C1 of plan
# 20260913-0416): every board directory declares what the assembly reads
# out of its bundle, and nothing the bundle no longer carries.
#
#   - board.env declares BOARD_FEATURES (a subset of the vocabulary below) as a
#     plain KEY=value line, and no IMAGE_KINDS;
#   - images.tsv (`# mica-boards images v1`, rows image|update <kind> <packer>
#     <runtime image> <suffix>) has an `image disk builtin` row and an `update full`
#     row; only disk among image kinds is builtin; update kinds are full, root and
#     kernel, all builtin; a builtin row names `-` as its runtime image, any other a
#     mica-build-env:<name> image row of locks/mica-build-env.lock; kinds and
#     suffixes are unique within each row type;
#   - the board carries its whole build (boards/README.md): Makefile,
#     kernel/Dockerfile and a git row <board>-kernel in locks/upstream.lock; a FIT
#     board also bsp.env, a git row <board>-uboot,
#     kernel/configure.sh, kernel/build.sh and loader/Dockerfile; its Makefile
#     includes nothing outside the board;
#   - manifests/board.pkgs exists and names at least one package; every
#     manifest is one package per line and names only packages a producer
#     of this repository emits (tools/deb/producers.sh);
#   - manifests/radio-<r>.pkgs names a radio in BOARD_FEATURES,
#     manifests/component-<c>.pkgs a word; any other manifest name is refused;
#   - a board carries no producer: producers/board runs over every board; its kernel, U-Boot,
#     firmware and definition are component artifacts (tools/component.sh), not packages;
#   - containers.env is gone: the product decides features, not the board.
#
# Discovered, not listed: a board is a directory with a board.env.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

FEATURE_VOCABULARY="wifi bluetooth display status-led can usb-gadget audio containers"

FAIL_N=0
PASS_N=0
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $*" >&2; }
pass() { PASS_N=$((PASS_N + 1)); }
in_list() { local n="$1"; shift; local i; for i in "$@"; do [ "$i" != "$n" ] || return 0; done; return 1; }

# KEY=value or KEY="value", nothing else; the value without its quotes.
plain_value() {
    local line
    line="$(grep -m1 -E "^$2=" "$1" || true)"
    [ -n "${line}" ] || return 1
    case "${line}" in *'$('* | *'`'* | *'${'*) return 2 ;; esac
    line="${line#*=}"
    line="${line#\"}"
    printf '%s\n' "${line%\"}"
}

declared=""
while read -r _producer _dir _arches packages _enablement; do
    declared="${declared} ${packages//,/ }"
done < <(bash tools/deb/producers.sh)
[ -n "${declared// /}" ] || { echo "FAIL: tools/deb/producers.sh named no package" >&2; exit 1; }

boards=0
for dir in boards/*/; do
    board="$(basename "${dir}")"
    [ -f "boards/${board}/board.env" ] || continue
    boards=$((boards + 1))

    if value="$(plain_value "boards/${board}/board.env" BOARD_FEATURES)"; then
        for f in ${value}; do in_list "${f}" ${FEATURE_VOCABULARY} || fail "${board}: BOARD_FEATURES names '${f}', not in: ${FEATURE_VOCABULARY}"; done
        pass
    else
        fail "boards/${board}/board.env declares no BOARD_FEATURES (or not as a plain KEY=value line)"
    fi
    ! grep -q '^IMAGE_KINDS=' "boards/${board}/board.env" || fail "${board}: board.env declares IMAGE_KINDS; the image kinds are boards/${board}/images.tsv"

    # images.tsv: what the board is flashed and updated with.
    images="boards/${board}/images.tsv"
    if [ ! -f "${images}" ]; then
        fail "${images} is missing; every board declares at least its disk image and its full update"
    elif [ "$(head -n1 "${images}")" != "# mica-boards images v1" ]; then
        fail "${images}: line 1 is not '# mica-boards images v1'"
    else
        rows="$(grep -v '^#' "${images}" || true)"
        bad="$(awk -F'\t' '($1 != "image" && $1 != "update") || NF != 5 || $2 !~ /^[a-z0-9][a-z0-9-]*$/ || $3 == "" || $4 == "" || $5 !~ /^[a-z0-9][a-z0-9.-]*$/' <<<"${rows}")"
        [ -z "${bad}" ] || fail "${images}: rows that are not image|update TAB <kind> TAB <packer> TAB <runtime image> TAB <suffix>: ${bad}"
        [ "$(awk -F'\t' '$1 == "image" && $2 == "disk" && $3 == "builtin"' <<<"${rows}" | wc -l)" = 1 ] || fail "${images}: no single image disk row with the packer builtin; disk is the canonical image every other kind derives from"
        [ -z "$(awk -F'\t' '$1 == "image" && $2 != "disk" && $3 == "builtin"' <<<"${rows}")" ] || fail "${images}: an image kind other than disk names the packer builtin; only the disk image is the assembly's own"
        [ "$(awk -F'\t' '$1 == "update" && $2 == "full"' <<<"${rows}" | wc -l)" = 1 ] || fail "${images}: no single update full row; every board can be updated whole"
        [ -z "$(awk -F'\t' '$1 == "update" && $2 !~ /^(full|root|kernel)$/' <<<"${rows}")" ] || fail "${images}: an update kind other than full, root or kernel (firmware waits until a device can install it)"
        [ -z "$(awk -F'\t' '$1 == "update" && $3 != "builtin"' <<<"${rows}")" ] || fail "${images}: an update row whose packer is not builtin; the assembly signs and packs update packages itself"
        for type in image update; do
            [ -z "$(awk -F'\t' -v t="${type}" '$1 == t { print $2 }' <<<"${rows}" | sort | uniq -d)" ] || fail "${images}: an ${type} kind is declared twice"
            [ -z "$(awk -F'\t' -v t="${type}" '$1 == t { print $5 }' <<<"${rows}" | sort | uniq -d)" ] || fail "${images}: an ${type} suffix is declared twice"
        done
        while IFS=$'\t' read -r type kind packer runtime _suffix; do
            [ -n "${type}" ] || continue
            if [ "${packer}" = builtin ]; then
                [ "${runtime}" = - ] || fail "${images}: the builtin ${type} ${kind} names the runtime image '${runtime}'; a builtin row runs in the assembly and names -"
                continue
            fi
            case "${runtime}" in
            mica-build-env:*) awk -F'\t' -v n="${runtime#mica-build-env:}" '$1 == "image" && $2 == "mica-build-env" && $3 == n { f = 1 } END { exit !f }' locks/mica-build-env.lock ||
                fail "${images}: ${type} ${kind} runs in ${runtime}, which locks/mica-build-env.lock names no image row for" ;;
            *) fail "${images}: ${type} ${kind} runs in '${runtime}', not a mica-build-env:<name> image of locks/mica-build-env.lock" ;;
            esac
        done <<<"${rows}"
        pass
    fi
    features="$(plain_value "boards/${board}/board.env" BOARD_FEATURES || true)"

    # The board's own build: nothing of it lives outside the board but common/.
    for f in Makefile kernel/Dockerfile; do
        [ -f "boards/${board}/${f}" ] || fail "boards/${board}/${f} is missing; a board carries its own kernel build"
    done
    trees="${board}-kernel"
    if [ "$(plain_value "boards/${board}/board.env" BOOT_BACKEND || true)" = uboot-fit ]; then
        for f in bsp.env kernel/configure.sh kernel/build.sh loader/Dockerfile; do
            [ -f "boards/${board}/${f}" ] || fail "boards/${board}/${f} is missing; a FIT board carries its own kernel and U-Boot build"
        done
        trees="${trees} ${board}-uboot"
    fi
    for tree in ${trees}; do
        bash tools/upstream.sh git "${tree}" commit >/dev/null 2>&1 || fail "locks/upstream.lock pins no git tree ${tree}; a board's kernel and U-Boot sources are pinned there"
    done
    ! grep -E '^[[:space:]]*-?include[[:space:]]+\.\./' "boards/${board}/Makefile" >/dev/null 2>&1 || fail "boards/${board}/Makefile includes a file outside the board"
    pass

    if [ ! -f "boards/${board}/manifests/board.pkgs" ]; then
        fail "boards/${board}/manifests/board.pkgs is missing; the bundle would carry no board package manifest"
    fi
    shopt -s nullglob
    for m in "boards/${board}"/manifests/*.pkgs; do
        base="$(basename "${m}" .pkgs)"
        case "${base}" in
        board) ;;
        radio-*) in_list "${base#radio-}" ${features} || fail "${m} names a radio the board's BOARD_FEATURES does not (${features:-none})" ;;
        component-?*) ;;
        *) fail "${m} belongs to no manifest family (board, radio-<r>, component-<c>)" ;;
        esac
        n=0
        lineno=0
        while IFS= read -r line || [ -n "${line}" ]; do
            lineno=$((lineno + 1))
            line="${line%%#*}"
            # shellcheck disable=SC2086
            set -- ${line}
            [ "$#" -gt 0 ] || continue
            [ "$#" -eq 1 ] || { fail "${m}:${lineno} names $# packages on one line"; continue; }
            in_list "$1" ${declared} || fail "${m}:${lineno} names '$1', which no producer of this repository emits"
            n=$((n + 1))
        done <"${m}"
        [ "${n}" -gt 0 ] || fail "${m} names no package"
        pass
    done
    shopt -u nullglob

    # The authenticated boot facts the assembly's kernel component and
    # firmware package read (plan 20260913-0416, C4): the firmware format
    # agrees with the boot backend, a FIT board names its device tree, its
    # watchdog symbol, its three load addresses and its loader, and every
    # board's command line carries the signed-boot floor.
    backend="$(plain_value "boards/${board}/board.env" BOOT_BACKEND || true)"
    format="$(plain_value "boards/${board}/board.env" FIRMWARE_FORMAT || true)"
    case "${backend}:${format}" in
    systemd-boot:efi | uboot-fit:rockchip-loader | uboot-fit:amlogic-boot0) pass ;;
    *) fail "${board}: BOOT_BACKEND=${backend:-unset} with FIRMWARE_FORMAT=${format:-unset}; systemd-boot boots efi, uboot-fit a rockchip-loader or an amlogic-boot0" ;;
    esac
    if [ "${backend}" = uboot-fit ]; then
        for key in FIT_DTB FIT_WATCHDOG FIT_LOAD_ADDRESSES UBOOT_BIN_NAME UBOOT_MAX_BYTES; do
            v="$(plain_value "boards/${board}/board.env" "${key}" || true)"
            [ -n "${v}" ] || fail "${board}: a FIT board declares ${key}"
        done
        addrs="$(plain_value "boards/${board}/board.env" FIT_LOAD_ADDRESSES || true)"
        [ "$(printf '%s\n' ${addrs} | grep -cE '^0x[0-9a-fA-F]+$')" -eq 3 ] || fail "${board}: FIT_LOAD_ADDRESSES is three hexadecimal addresses (kernel, initramfs, device tree), not '${addrs}'"
        case "${format}" in
        amlogic-boot0) for key in UBOOT_MIN_BYTES UBOOT_PAYLOAD_OFFSET_BYTES; do [ -n "$(plain_value "boards/${board}/board.env" "${key}" || true)" ] || fail "${board}: an amlogic-boot0 board declares ${key}"; done ;;
        rockchip-loader) for key in UBOOT_SEEK_SECTOR LOADER_MAGIC_HEX; do [ -n "$(plain_value "boards/${board}/board.env" "${key}" || true)" ] || fail "${board}: a rockchip-loader board declares ${key}"; done ;;
        esac
    fi
    cmdline="$(plain_value "boards/${board}/board.env" BOARD_CMDLINE_ARGS || true)"
    for arg in dm_verity.require_signatures=1 rdinit=/init; do
        case " ${cmdline} " in *" ${arg} "*) ;; *) fail "${board}: BOARD_CMDLINE_ARGS is the authenticated command line and lacks ${arg}" ;; esac
    done

    # BOARD_FEATURES is the one capability declaration; the readings it used
    # to be paired with (BOARD_RADIOS, BOARD_HAS_STATUS_LED, BOARD_HAS_DISPLAY)
    # are gone, and a board that still carries one has two places to disagree.
    for key in BOARD_RADIOS BOARD_HAS_STATUS_LED BOARD_HAS_DISPLAY; do
        ! grep -q "^${key}=" "boards/${board}/board.env" || fail "${board}: board.env still declares ${key}; BOARD_FEATURES is the capability set and its readers read it"
    done

    # The board is data: no producer of its own (producers/board runs over every
    # board), and the one control template it carries is the board package's.
    stray="$(find "boards/${board}" -path "boards/${board}/extras" -prune -o -name producer.env -print)"
    [ -z "${stray}" ] || fail "boards/${board} carries a producer.env outside extras/ (${stray}); a board is data, the producers are under producers/"
    [ -f "boards/${board}/package/control/mica-board-${board}.control" ] || fail "boards/${board}/package/control/mica-board-${board}.control is missing; the board package's control template"
    grep -q '^BOARD_PACKAGE_ENABLEMENT=[0-9]\+$' "boards/${board}/board.env" || fail "${board}: board.env declares no BOARD_PACKAGE_ENABLEMENT (how many units the board package enables; the gate holds it)"
    pass
    [ ! -e "boards/${board}/containers.env" ] || fail "boards/${board}/containers.env exists; that switch moved to the product"

    # The board component is data this directory carries, and outputs.tsv is
    # the list the assembly holds it to. CI stages the component and refuses an
    # unexpected or missing file, but only after the kernels are built; the two
    # sets can be compared here, without certificates, in no time at all.
    listed="$(awk -F'\t' '$1 == "file" && $2 == "board" && $3 !~ /^trust\// { print $3 }' "boards/${board}/outputs.tsv" | LC_ALL=C sort)"
    present="$( (cd "boards/${board}" && find board.env evidence.json images.tsv outputs.tsv manifests -type f 2>/dev/null) | LC_ALL=C sort)"
    if [ "${listed}" = "${present}" ]; then
        pass
    else
        fail "${board}: outputs.tsv's board rows and the files boards/${board} carries differ: $(diff <(printf '%s\n' "${listed}") <(printf '%s\n' "${present}") | sed 's/^</only in outputs.tsv: /; s/^>/not listed by outputs.tsv: /' | tr '\n' ' ')"
    fi

    # THE BOOT LOGO'S FIVE ARTEFACTS MOVE TOGETHER. BOARD_BOOT_LOGO is the one
    # switch, and a board either has all five or none: the kernel symbol, the
    # render step, the forced command line's position, and the two policy
    # files that keep the logo's VT idle. The point is not tidiness -- a
    # drop-in that outlives its logo removes a working VT login to protect
    # nothing, and a logo with no mask is covered by the first getty anyone
    # enables.
    logo_flag=0
    grep -q '^BOARD_BOOT_LOGO=1$' "boards/${board}/board.env" && logo_flag=1
    have=0
    # Two forms, both legitimate: a fragment line, or `scripts/config --enable
    # LOGO` in the board's configure hook, which is how cx3576 does it over a
    # vendor config that says `# CONFIG_LOGO is not set`.
    grep -rqsE '^CONFIG_LOGO=y$|--enable LOGO( |$)' "boards/${board}/kernel/" && have=$((have + 1))
    # The command line half is two words, not one: the position AND the cursor.
    # A logo with a cursor blinking on top of it is the same half-decision as a
    # logo nobody can type under, and it is the half a user sees on every boot.
    case "$(sed -n 's/^BOARD_CMDLINE_ARGS=//p' "boards/${board}/board.env")" in
    *fbcon=logo-pos:*vt.global_cursor_default=0* | *vt.global_cursor_default=0*fbcon=logo-pos:*)
        have=$((have + 1)) ;;
    esac
    { [ -f "boards/${board}/kernel/hooks/prepare.sh" ] && grep -q mklogo "boards/${board}/kernel/hooks/prepare.sh"; } ||
        grep -qs mklogo "boards/${board}/kernel/Dockerfile" && have=$((have + 1))
    [ -f "boards/${board}/package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf" ] && have=$((have + 1))
    [ -L "boards/${board}/package/overlay/etc/systemd/system/getty@tty1.service" ] && have=$((have + 1))
    if { [ "${logo_flag}" = 1 ] && [ "${have}" = 5 ]; } || { [ "${logo_flag}" = 0 ] && [ "${have}" = 0 ]; }; then
        pass
    else
        fail "${board}: BOARD_BOOT_LOGO=${logo_flag} with ${have} of the five logo artefacts present (CONFIG_LOGO, fbcon=logo-pos: with vt.global_cursor_default=0, the mklogo render, the logind drop-in, the getty@tty1 mask). They move together or not at all"
    fi

    # THE UNIFIED CGROUP HIERARCHY, asserted here because no kernel symbol can
    # express it. podman picks its validator from what is mounted at
    # /sys/fs/cgroup: under v1 it takes verifyContainerResourcesCgroupV1, where
    # a memory limit is DISCARDED WITH A WARNING and the container runs
    # unbounded. A board could select that for every container on it with one
    # word in its forced command line, and no capability row would see it.
    # Worse on the 6.12 boards, whose kernels carry no v1 memory controller at
    # all (`# CONFIG_MEMCG_V1 is not set`): there a v1 hierarchy would have no
    # memory limits rather than weak ones. The line holds today; this is what
    # keeps it holding.
    cmdline="$(sed -n 's/^BOARD_CMDLINE_ARGS=//p' "boards/${board}/board.env" | tr -d '"')"
    case " ${cmdline} " in
    *" systemd.unified_cgroup_hierarchy=0 "* | *" cgroup_no_v1"*)
        fail "${board}: BOARD_CMDLINE_ARGS selects a cgroup v1 hierarchy; podman would validate on its v1 branch, where a memory limit is discarded with a warning and the container runs unbounded"
        ;;
    *) pass ;;
    esac

    # A release target owes an evidence document. The assembly reads it at
    # `--release assemble`, which runs after that product's archives and images
    # are built, so a board that publishes without one fails there rather than
    # here -- after the expensive part.
    if grep -q '^BOARD_RELEASE_TARGET=1$' "boards/${board}/board.env"; then
        if [ ! -f "boards/${board}/evidence.json" ]; then
            fail "boards/${board}/evidence.json is missing and BOARD_RELEASE_TARGET=1; the assembly's release manifest requires it and takes the product's bootAssurance from it"
        elif out="$(python3 tests/evidence-schema.py "boards/${board}/evidence.json" "${board}" 2>&1)"; then
            pass
        else
            fail "${out}"
        fi
    fi
done
[ "${boards}" -gt 0 ] || { echo "FAIL: no directory with a board.env; the loop above checked nothing" >&2; exit 1; }

# boards/boards.tsv is the tree's board list: every board directory listed with its
# architecture and boot backend, its packages built here, its bundle files named.
if out="$(bash tools/boards.sh check 2>&1)"; then pass; else fail "${out}"; fi

echo "board-contract-test: ${boards} board(s), ${PASS_N} passed, ${FAIL_N} failed"
[ "${FAIL_N}" -eq 0 ]
