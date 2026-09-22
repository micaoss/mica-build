#!/usr/bin/env bash
# ENTRY SCRIPT -- proof 4 of the plan's P1 row: what a required-signature FIT
# configuration buys, and what it refuses.
#
# WHAT IT PROVES. That U-Boot, with a public key in its control FDT marked
# `required = "conf"`, boots a FIT whose configuration signature verifies and
# refuses every other shape: a FIT with no signature at all, a FIT signed by a
# key the control FDT does not carry, and a FIT whose kernel, DTB or initramfs
# has one bit changed after signing -- each refused with U-Boot's own message,
# and the boot stops rather than continuing with the payload.
#
# ON WHICH TARGET. The U-Boot SANDBOX, built from the same upstream commit
# mica-boards:boards/cx3576/loader/Dockerfile builds for the board, so the verification
# code under test is the code that ships. It is not the board: cx3576 silicon
# is not here and QEMU has no rk3576 machine, so what this proves is the
# behaviour of that U-Boot's FIT verifier, not a boot on the device.
# tests/suites/signed-boot-lab/cx3576-control-fdt.sh covers the other half -- that the
# board's own control FDT takes the key.
#
#   bash tests/suites/signed-boot-lab/images.sh --uboot
#   bash tests/suites/signed-boot-lab/fit-sandbox.sh \
#       [--kernel _out/boards/cx3576/kernel/dev/Image] \
#       [--dtb _out/boards/cx3576/kernel/dev/rk3576-src.dtb]
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
lab_require_image "${UBOOT_IMAGE}"

KERNEL="${REPO_ROOT}/_out/boards/cx3576/kernel/dev/Image"
DTB="${REPO_ROOT}/_out/boards/cx3576/kernel/dev/rk3576-src.dtb"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --kernel) KERNEL="${2:?--kernel takes a file}"; shift 2 ;;
        --dtb)    DTB="${2:?--dtb takes a file}"; shift 2 ;;
        *) echo "error: '$1' is not an option this script takes" >&2; exit 2 ;;
    esac
done
for f in "${KERNEL}" "${DTB}"; do
    [ -s "${f}" ] || { echo "error: ${f} does not exist; build the board kernel first: make cx3576-kernel" >&2; exit 1; }
done

mkdir -p "${LAB_WORK}"
cp "${KERNEL}" "${LAB_WORK}/fit-kernel"
cp "${DTB}" "${LAB_WORK}/fit-board.dtb"
lab_docker_run "${UBOOT_IMAGE}" bash /lab/fit-sandbox-inner.sh /w/fit-kernel /w/fit-board.dtb
