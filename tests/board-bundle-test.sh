#!/usr/bin/env bash
# tools/board-pool.sh's bundle rules over fixture bundles: a uboot-fit board
# carries kernel/dev and kernel/prod and no kernel/ of its own, a systemd-boot
# board one kernel/, and --kernel-dir names the directory a product of each
# profile packs.
#
#   bash tests/board-bundle-test.sh      (make os-board-bundle-test; no network, no docker)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SCRATCH="${REPO_ROOT}/tmp/board-bundle-test.$$"
mkdir -p "${SCRATCH}"
trap 'rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

printf 'fixture certificate\n' >"${SCRATCH}/cert.pem"
export MICA_VERITY_TRUST_CERT="${SCRATCH}/cert.pem" MICA_BOARDS_OUT="${SCRATCH}/boards"

# bundle <board> <backend> <kernel dir>...
bundle() {
    local dir="${SCRATCH}/boards/$1" d
    rm -rf "${dir}"
    mkdir -p "${dir}/manifests" "${dir}/trust"
    printf 'LAYOUT_BOARD=%s\nBOOT_BACKEND=%s\n' "$1" "$2" >"${dir}/board.env"
    : >"${dir}/manifests/board.pkgs"
    cp "${SCRATCH}/cert.pem" "${dir}/trust/verity-signer.cert.pem"
    shift 2
    for d in "$@"; do
        mkdir -p "${dir}/${d}"
        for f in config kernel.release modules.tar; do printf '%s\n' "${d}" >"${dir}/${d}/${f}"; done
    done
    printf '%s\n' "${dir}"
}
accepts() { # <label> <dir>
    if out="$(bash tools/board-pool.sh --check "$2" 2>&1)"; then pass "$1"; else fail "$1: ${out}"; fi
}
refuses() { # <label> <fragment> <dir>
    if out="$(bash tools/board-pool.sh --check "$3" 2>&1)"; then
        fail "$1: accepted"
    elif printf '%s' "${out}" | grep -F -- "$2" >/dev/null; then
        pass "$1: refused naming '$2'"
    else
        fail "$1: refused, but not naming '$2': ${out}"
    fi
}

accepts "a FIT bundle with kernel/dev and kernel/prod" "$(bundle fitboard uboot-fit kernel/dev kernel/prod)"
refuses "a FIT bundle without its prod kernel" "carries no kernel/prod/config" "$(bundle fitboard uboot-fit kernel/dev)"
refuses "a FIT bundle with a kernel/ of its own" "with a kernel/ of its own" "$(bundle fitboard uboot-fit kernel kernel/dev kernel/prod)"
refuses "a FIT bundle with only the old single kernel" "carries no kernel/dev/config" "$(bundle fitboard uboot-fit kernel)"
accepts "a UEFI bundle with one kernel/" "$(bundle efiboard systemd-boot kernel)"
refuses "a UEFI bundle with profile kernels" "with profile kernel directories" "$(bundle efiboard systemd-boot kernel kernel/dev)"
refuses "a bundle with no known boot backend" "names no BOOT_BACKEND" "$(bundle oddboard grub kernel)"
dir="$(bundle fitboard uboot-fit kernel/dev kernel/prod)"
printf 'another certificate\n' >"${dir}/trust/verity-signer.cert.pem"
refuses "a bundle built against another verity certificate" "verity trust certificate that is not" "${dir}"

bundle fitboard uboot-fit kernel/dev kernel/prod >/dev/null
bundle efiboard systemd-boot kernel >/dev/null
for pair in "fitboard dev ${SCRATCH}/boards/fitboard/kernel/dev" "fitboard prod ${SCRATCH}/boards/fitboard/kernel/prod" \
    "efiboard dev ${SCRATCH}/boards/efiboard/kernel" "efiboard prod ${SCRATCH}/boards/efiboard/kernel"; do
    set -- ${pair}
    got="$(bash tools/board-pool.sh --kernel-dir "$1" "$2" 2>&1 || true)"
    [ "${got}" = "$3" ] && pass "--kernel-dir $1 $2 is ${3#"${SCRATCH}"/}" || fail "--kernel-dir $1 $2 printed ${got}, not $3"
done
if bash tools/board-pool.sh --kernel-dir fitboard staging >/dev/null 2>&1; then fail "--kernel-dir accepted the profile 'staging'"; else pass "--kernel-dir refuses a profile other than dev or prod"; fi

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
