#!/usr/bin/env bash
# tools/image-kinds.sh: the disk kind is packed, reserved and unknown kinds are refused by name.
#
#   bash tests/image-kinds-test.sh      (make os-image-kinds-test; no docker, no network)
set -euo pipefail
cd "$(dirname "$0")/.."
SCRATCH="$(pwd)/tmp/image-kinds-test.$$"
mkdir -p "${SCRATCH}"
trap 'rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
refuses() { # <label> <fragment> <args...>
    local label="$1" fragment="$2" out
    shift 2
    if out="$(bash tools/image-kinds.sh "$@" 2>&1)"; then
        fail "${label}: accepted"
    elif printf '%s' "${out}" | grep -F -- "${fragment}" >/dev/null; then
        pass "${label}: refused naming '${fragment}'"
    else
        fail "${label}: refused, but not naming '${fragment}': ${out}"
    fi
}

# A product out with the image component's output.
out="${SCRATCH}/product"
mkdir -p "${out}/image"
printf 'image bytes\n' >"${out}/image/mica-fixture-20260915-000000.img"
(cd "${out}/image" && sha256sum mica-fixture-20260915-000000.img >SHA256SUMS)

if bash tools/image-kinds.sh check disk >/dev/null 2>&1; then pass "disk is a produced kind"; else fail "check disk was refused"; fi
if bash tools/image-kinds.sh pack "${out}" disk >/dev/null 2>&1 && [ "$(cat "${out}/kinds.tsv")" = "disk	image/mica-fixture-20260915-000000.img" ]; then
    pass "pack disk records the raw image as the disk output"
else
    fail "pack disk: $(bash tools/image-kinds.sh pack "${out}" disk 2>&1; cat "${out}/kinds.tsv" 2>/dev/null)"
fi
refuses "a reserved Rockchip kind" "rockchip-update' is a Rockchip update.img, planned in mica:docs/plan/20260912-2253-rockchip-update-image.md" check disk rockchip-update
refuses "a reserved Amlogic kind" "amlogic-burn' is an Amlogic burn package" check amlogic-burn
refuses "an unknown kind" "the image kind 'floppy' is unknown" check floppy
rm -f "${out}/kinds.tsv"
refuses "a reserved kind is refused before any packer runs" "rockchip-update" pack "${out}" disk rockchip-update
[ ! -e "${out}/kinds.tsv" ] && pass "a refused pack writes no kinds.tsv" || fail "a refused pack left ${out}/kinds.tsv"
printf 'other bytes\n' >"${out}/image/mica-fixture-20260915-000000.img"
refuses "a disk image that is not the one SHA256SUMS names" "is not the image" pack "${out}" disk

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
