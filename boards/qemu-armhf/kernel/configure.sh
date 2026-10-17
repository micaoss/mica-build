#!/usr/bin/env bash
# mica-build-side: container -- kconfig runs in the bsp builder image against the tree fetched there.
#
# Resolve the board's kernel configuration and prove it carries both fragments, before anything is compiled.
#
#   configure.sh <source-tree> <defconfig> <mica-required-fragment> <board-fragment> <command line> <resolved>
#
# The defconfig is the base and the composed floor and the board's fragment the delta; the forced command line
# is the board's. Every =y line of both fragments must survive olddefconfig, every option they record off stays
# off, and the LSM list and the trust anchor are the floor's. <resolved> receives the configuration as recorded
# (config/qemu-armhf.config): its option lines, without the toolchain's version strings.
set -euo pipefail
[ "$#" -eq 6 ] || { echo 'usage: configure.sh <source-tree> <defconfig> <mica-required-fragment> <board-fragment> <command line> <resolved>' >&2; exit 1; }
SRC="$1" DEFCONFIG="$2" FLOOR="$3" BOARD="$4" CMDLINE="$5" RESOLVED="$6"
[ -n "${CMDLINE}" ] || { echo "error: the command line is empty; the board's Makefile passes board.env's BOARD_CMDLINE_ARGS" >&2; exit 1; }
cd "${SRC}"
mk() { make ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- "$@"; }
mk "${DEFCONFIG}"
ARCH=arm scripts/kconfig/merge_config.sh -m .config "${FLOOR}" "${BOARD}"
scripts/config --set-str CMDLINE "${CMDLINE}"
mk olddefconfig
for line in $(sed -n 's/^\(CONFIG_[A-Z0-9_]*=y\)$/\1/p' "${FLOOR}" "${BOARD}"); do
    grep -qx "${line}" .config || { echo "error: missing required option ${line}" >&2; exit 1; }
done
for sym in $(sed -n 's/^# \(CONFIG_[A-Z0-9_]*\) is not set$/\1/p' "${FLOOR}" "${BOARD}"); do
    ! grep -q "^${sym}=" .config || { echo "error: ${sym} is recorded off and is on" >&2; exit 1; }
done
grep -qx "$(grep '^CONFIG_LSM=' "${FLOOR}")" .config || { echo 'error: the LSM list is not the floor'"'"'s' >&2; exit 1; }
grep -qx "$(grep '^CONFIG_SYSTEM_TRUSTED_KEYS=' "${FLOOR}")" .config || { echo 'error: the trust anchor is not the floor'"'"'s' >&2; exit 1; }
grep -E '^(CONFIG_[A-Za-z0-9_]+=|# CONFIG_[A-Za-z0-9_]+ is not set$)' .config \
    | grep -vE '^CONFIG_(CC_VERSION_TEXT|GCC_VERSION|AS_VERSION|LD_VERSION|LLD_VERSION|CLANG_VERSION|PAHOLE_VERSION|RUSTC_VERSION|RUSTC_LLVM_VERSION)=' \
    > "${RESOLVED}"
echo "config: ${DEFCONFIG} with the floor and the board's fragment"
