#!/usr/bin/env bash
# ENTRY SCRIPT -- the artefact half of proof 4: the board's own U-Boot control
# FDT takes a required FIT signing key.
#
# WHAT IT PROVES. That `mkimage -K u-boot.dtb -r` over the control FDT the
# cx3576 U-Boot build produces writes `/signature/key-micadev` with
# `required = "conf"` and `algo = sha256,rsa2048`, and by how much the DTB
# grows. Together with fit-sandbox.sh this is "the board's U-Boot could be
# given an anchor, and a U-Boot with one refuses what it should" -- the two
# halves that can be measured without the hardware. What remains untested is
# repacking `u-boot-rockchip.bin` around the modified control FDT and booting
# it, which needs the board.
#
# ON WHICH TARGET. The cx3576 U-Boot artefact of this checkout; mkimage comes
# from the sandbox image, built at the same upstream commit as the board's.
#
#   bash tests/suites/signed-boot-lab/cx3576-control-fdt.sh --dtb <u-boot.dtb>
#
# The board build does not export u-boot.dtb today; take it out of the build
# stage, e.g. with a `--target` build that copies /uboot/u-boot.dtb, or from a
# board tree that has one.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
lab_require_image "${UBOOT_IMAGE}"

DTB=""
KERNEL="${REPO_ROOT}/_out/boards/cx3576/kernel/dev/Image"
BOARD_DTB="${REPO_ROOT}/_out/boards/cx3576/kernel/dev/rk3576-src.dtb"
while [ "$#" -gt 0 ]; do
    case "$1" in
        --dtb)       DTB="${2:?--dtb takes the U-Boot control FDT}"; shift 2 ;;
        --kernel)    KERNEL="${2:?--kernel takes a file}"; shift 2 ;;
        --board-dtb) BOARD_DTB="${2:?--board-dtb takes a file}"; shift 2 ;;
        *) echo "error: '$1' is not an option this script takes" >&2; exit 2 ;;
    esac
done
[ -n "${DTB}" ] || { echo "error: --dtb is required and names the U-Boot control FDT to write the key into" >&2; exit 2; }
for f in "${DTB}" "${KERNEL}" "${BOARD_DTB}"; do
    [ -s "${f}" ] || { echo "error: ${f} does not exist" >&2; exit 1; }
done

mkdir -p "${LAB_WORK}"
cp "${DTB}" "${LAB_WORK}/u-boot.dtb"
cp "${KERNEL}" "${LAB_WORK}/fit-kernel"
cp "${BOARD_DTB}" "${LAB_WORK}/fit-board.dtb"
lab_docker_run "${UBOOT_IMAGE}" bash /lab/cx3576-control-fdt-inner.sh \
    /w/u-boot.dtb /w/fit-kernel /w/fit-board.dtb
