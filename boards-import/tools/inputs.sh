#!/usr/bin/env bash
# The inputs hash of a board component: sha256 over a sorted manifest of
# everything that determines its bytes. A release reuses a published component
# whose mica.inputs annotation equals it, instead of building it again.
#
#   bash tools/inputs.sh <board> <component>            the hash
#   bash tools/inputs.sh --manifest <board> <component> the manifest it is taken over
#
# Manifest lines are `<kind> <name> <value>`: `file <path> <sha256>` for a tracked
# file (paths under boards/<board>/ are recorded without the board's directory,
# and the board's Makefile without its BOARD line, so two boards with identical
# inputs hash alike), `pin` rows of locks/ without their board-named key, `cert`
# the sha256 of a trust certificate, `builder` the architecture that builds it.
# The set is deliberately wide: a file that might matter is in it, since a
# missed input would reuse a stale component and an extra one only rebuilds.
#
#   kernel    boards/<board>/kernel/, bsp.env, Makefile, flash/assets/ (a boot logo), board.env's
#             BOARD_CMDLINE_ARGS and MICA_ARCH, common/kernel/, common/scripts/, common/trust/, the kernel
#             git row, the mica-build-env bsp image row (the toolchain), the verity certificate, the builder
#   uboot     boards/<board>/loader/, bsp.env, Makefile, common/uboot/, common/scripts/, common/trust/, the
#             uboot and rkbin git rows, the board's source rows, the bsp and debian image rows, the boot
#             certificate, the builder
#   firmware  boards/<board>/firmware/ and board.env's BOARD_FIRMWARE_FILES
#   board     board.env, evidence.json, images.tsv, manifests/, outputs.tsv, the verity certificate
#
# VERITY_TRUST_CERT and FIT_TRUST_CERT name the certificates (default meta/verity/
# and meta/boot/signer.cert.pem). The builder is the runner a release builds on:
# the board's architecture for its kernel (native), amd64 for U-Boot (whose FIT
# host tools the assembly runs on x86-64).
set -euo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "inputs.sh: error: $*" >&2; exit 1; }

MODE=hash
[ "${1-}" != --manifest ] || { MODE=manifest; shift; }
[ "$#" -eq 2 ] || die "usage: bash tools/inputs.sh [--manifest] <board> <component>"
BOARD="$1" COMPONENT="$2"
ARCH="$(bash "${REPO_ROOT}/tools/boards.sh" arch "${BOARD}")"
case " $(bash "${REPO_ROOT}/tools/component.sh" list "${BOARD}" | tr '\n' ' ') " in *" ${COMPONENT} "*) ;; *) die "${BOARD} has no ${COMPONENT} component" ;; esac
cd "${REPO_ROOT}"
B="boards/${BOARD}"

files() { # <path>...: tracked files, board paths without boards/<board>/
    git ls-files -z -- "$@" | while IFS= read -r -d '' f; do
        case "${f}" in
        "${B}/Makefile") printf 'file Makefile %s\n' "$(grep -v '^BOARD := ' "${f}" | sha256sum | cut -d' ' -f1)" ;;
        "${B}"/*) printf 'file %s %s\n' "${f#"${B}"/}" "$(sha256sum "${f}" | cut -d' ' -f1)" ;;
        *) printf 'file %s %s\n' "${f}" "$(sha256sum "${f}" | cut -d' ' -f1)" ;;
        esac
    done
}
env_value() { printf 'env %s %s\n' "$1" "$(sed -n "s/^$1=//p" "${B}/board.env")"; }
git_row() { awk -F'\t' -v n="${BOARD}-$1" '$1 == "git" && $2 == n { printf "pin git-%s %s %s %s\n", "'"$1"'", $3, $4, $5 }' locks/upstream.lock; }
source_rows() { awk -F'\t' -v p="${BOARD}-" '$1 == "source" && index($2, p) == 1 { printf "pin source-%s %s %s %s %s\n", substr($2, length(p) + 1), $3, $4, $5, $6 }' locks/upstream.lock; }
image_row() { printf 'pin image-%s %s\n' "$1" "$(bash tools/from.sh --upstream "$1")"; }
# The toolchain is an image now: its digest is the pin (mica-build-env bsp).
bsp_row() { printf 'pin image-bsp %s\n' "$(bash tools/from.sh --ref bsp)"; }
cert() { # <name> <file>
    [ -f "$2" ] || die "$2 does not exist; the ${1} certificate is an input of the ${COMPONENT} component"
    printf 'cert %s %s\n' "$1" "$(sha256sum "$2" | cut -d' ' -f1)"
}
VERITY="${VERITY_TRUST_CERT:-meta/verity/signer.cert.pem}"
FIT="${FIT_TRUST_CERT:-meta/boot/signer.cert.pem}"

{
    printf 'component %s\n' "${COMPONENT}"
    case "${COMPONENT}" in
    kernel)
        files "${B}/kernel" "${B}/bsp.env" "${B}/Makefile" "${B}/flash/assets" common/kernel common/scripts common/trust
        env_value BOARD_CMDLINE_ARGS
        env_value MICA_ARCH
        git_row kernel
        bsp_row
        cert verity "${VERITY}"
        printf 'builder %s\n' "${ARCH}"
        ;;
    uboot)
        files "${B}/loader" "${B}/bsp.env" "${B}/Makefile" common/uboot common/scripts common/trust
        git_row uboot
        git_row rkbin
        source_rows
        bsp_row
        image_row debian:trixie-slim
        cert boot "${FIT}"
        # U-Boot is cross-compiled on x86-64 for every board: it ships FIT host tools the assembly runs on x86-64.
        printf 'builder %s\n' amd64
        ;;
    firmware)
        files "${B}/firmware"
        env_value BOARD_FIRMWARE_FILES
        ;;
    board)
        files "${B}/board.env" "${B}/evidence.json" "${B}/images.tsv" "${B}/manifests" "${B}/outputs.tsv"
        cert verity "${VERITY}"
        ;;
    esac
} | sort >"${TMPDIR:-/tmp}/inputs.$$"
trap 'rm -f "${TMPDIR:-/tmp}/inputs.$$"' EXIT
if [ "${MODE}" = manifest ]; then cat "${TMPDIR:-/tmp}/inputs.$$"; else sha256sum <"${TMPDIR:-/tmp}/inputs.$$" | cut -d' ' -f1; fi
