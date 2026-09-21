#!/usr/bin/env bash
# A board's components: the trees a release publishes as the OCI artifacts
# <component>.<board>.<YYYYMMDD-HHMM>, out of the board's build (_out/<board>/)
# and its directory.
#
#   bash tools/component.sh list <board>                      board, kernel, and uboot and firmware where it has them
#   bash tools/component.sh stage <board> <component> <dir>   <dir>: exactly the component's files of its outputs.tsv
#
#   board     board.env, evidence.json, images.tsv, manifests/, outputs.tsv, trust/verity-signer.cert.pem
#   kernel    kernel/ from _out/<board>/kernel (a FIT board's kernel/dev/ and kernel/prod/)
#   uboot     uboot/ (and uboot-package/) from the board's loader build, by its FIRMWARE_FORMAT
#   firmware  firmware/<BOARD_FIRMWARE_FILES> and component-copyright
#
# VERITY_TRUST_CERT names the verity certificate the kernel was built against
# (default meta/verity/signer.cert.pem). A staged tree that is not exactly what
# outputs.tsv lists for the component is refused.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "component.sh: error: $*" >&2; exit 1; }

# The first match, taken in sed: `| head -1` would leave sed writing into a
# closed pipe, which pipefail reports as a failure.
value() { sed -n "/^$2=/{s/^$2=\"\{0,1\}\([^\"]*\)\"\{0,1\}\$/\1/;p;q;}" "${REPO_ROOT}/boards/$1/board.env"; }
list() { # <board>
    echo board
    echo kernel
    [ "$(bash "${REPO_ROOT}/tools/boards.sh" boot "$1")" != uboot-fit ] || echo uboot
    [ -z "$(value "$1" BOARD_FIRMWARE_FILES)" ] || echo firmware
}
tree() { mkdir -p "$2"; cp -a "$1"/. "$2"/; }
need() { [ -e "$1" ] || die "$1 does not exist; $2"; }

stage() { # <board> <component> <dir>
    local board="$1" component="$2" dir="$3" out="${REPO_ROOT}/_out/$1" src="${REPO_ROOT}/boards/$1" f name
    case " $(list "${board}" | tr '\n' ' ') " in *" ${component} "*) ;; *) die "${board} has no ${component} component" ;; esac
    rm -rf "${dir}"
    mkdir -p "${dir}"
    case "${component}" in
    board)
        install -m 0644 "${src}/board.env" "${dir}/board.env"
        install -m 0644 "${src}/outputs.tsv" "${dir}/outputs.tsv"
        install -m 0644 "${src}/images.tsv" "${dir}/images.tsv"
        [ ! -f "${src}/evidence.json" ] || install -m 0644 "${src}/evidence.json" "${dir}/evidence.json"
        tree "${src}/manifests" "${dir}/manifests"
        f="${VERITY_TRUST_CERT:-${REPO_ROOT}/meta/verity/signer.cert.pem}"
        need "${f}" "the verity trust certificate the kernel was built against; set VERITY_TRUST_CERT"
        install -D -m 0644 "${f}" "${dir}/trust/verity-signer.cert.pem"
        ;;
    kernel)
        need "${out}/kernel" "run 'make ${board}-kernel'"
        tree "${out}/kernel" "${dir}/kernel"
        ;;
    uboot)
        case "$(value "${board}" FIRMWARE_FORMAT)" in
        rockchip-loader) need "${out}/uboot-mica" "run 'make ${board}-firmware'"; tree "${out}/uboot-mica" "${dir}/uboot" ;;
        amlogic-boot0)
            for f in uboot uboot-package; do need "${out}/${f}" "run 'make ${board}-firmware'"; tree "${out}/${f}" "${dir}/${f}"; done
            ;;
        *) die "${board} declares FIRMWARE_FORMAT=$(value "${board}" FIRMWARE_FORMAT), which has no uboot component here" ;;
        esac
        ;;
    firmware)
        mkdir -p "${dir}/firmware"
        for f in $(value "${board}" BOARD_FIRMWARE_FILES); do
            name="${f#/usr/lib/firmware/}"
            install -m 0644 "${src}/firmware/${name}" "${dir}/firmware/${name}"
        done
        need "${src}/firmware/component-copyright" "the copyright of the board's firmware files"
        install -m 0644 "${src}/firmware/component-copyright" "${dir}/component-copyright"
        ;;
    esac
    bash "${REPO_ROOT}/tools/boards.sh" component-is "${board}" "${component}" "${dir}"
}

case "${1-}:$#" in
list:2) bash "${REPO_ROOT}/tools/boards.sh" arch "$2" >/dev/null; list "$2" ;;
stage:4) bash "${REPO_ROOT}/tools/boards.sh" arch "$2" >/dev/null; stage "$2" "$3" "$4" ;;
*) die "usage: bash tools/component.sh list <board> | stage <board> <component> <dir>" ;;
esac
