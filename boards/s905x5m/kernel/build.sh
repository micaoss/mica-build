#!/usr/bin/env bash
# mica-build-side: container. Compile an amlogic board's kernel, modules and
# device tree, build the board's out-of-tree modules against it, index the
# complete module set and pack what the bundle takes.
#
#   build.sh <source-tree> <expected-kernel-release> <dtb> <dtb-artifact-path> <board-dir> <board-hooks-dir>
#   build.sh --image <source-tree> <expected-kernel-release>
#
# --image relinks only the Image of a tree this script built before, after its
# command line moved to another profile (common/kernel/set-profile.sh): with the
# same make variables Kbuild recompiles only the objects that read
# CONFIG_CMDLINE; the modules and the device tree are those of the first build.
#
# The device tree is registered in the vendor dts Makefile when the tree does
# not list it. modules.tar is the BSP interface and must already carry the
# indexes for the complete module set -- the composer deliberately runs no
# depmod -- so depmod runs here after the board's modules hook has installed
# its modules under /kmods. CROSS_COMPILE comes from the environment.
set -euo pipefail
CROSS=(ARCH=arm64 CROSS_COMPILE="${CROSS_COMPILE-}")
# The vendor tree needs this warning demoted; the relink passes the same value,
# or Kbuild would see changed flags and recompile everything.
KCFLAGS=-Wno-error=enum-int-mismatch
if [ "${1-}" = --image ]; then
    [ "$#" -eq 3 ] || { echo "usage: build.sh --image <source-tree> <expected-kernel-release>" >&2; exit 1; }
    cd "$2"
    make "${CROSS[@]}" -j"$(nproc)" KCFLAGS="${KCFLAGS}" Image
    [ "$(cat include/config/kernel.release)" = "$3" ] || { echo "error: the relinked tree is $(cat include/config/kernel.release); this family expects $3" >&2; exit 1; }
    exit 0
fi
[ "$#" -eq 6 ] || {
    echo "usage: build.sh <source-tree> <expected-kernel-release> <dtb> <dtb-artifact-path> <board-dir> <board-hooks-dir>" >&2
    exit 1
}
SRC="$1"
KERNEL_EXPECT="$2"
DTB="$3"
DTB_ARTIFACT="$4"
BOARD_DIR="$5"
HOOKS="$6"
[ -n "${KERNEL_EXPECT}" ] || { echo "error: build.sh was given no expected kernel release" >&2; exit 1; }
[ -n "${DTB}" ] || { echo "error: build.sh was given no device tree to build (KERNEL_DTB in bsp.env)" >&2; exit 1; }

cd "${SRC}"
DTS_MAKEFILE=common_drivers/arch/arm64/boot/dts/amlogic/Makefile
if ! grep -Fq "dtb-y += ${DTB}" "${DTS_MAKEFILE}"; then
    printf '%s\n' "dtb-y += ${DTB}" >> "${DTS_MAKEFILE}"
fi
make "${CROSS[@]}" -j"$(nproc)" KCFLAGS="${KCFLAGS}" \
    Image modules "amlogic/${DTB}"
kernel_release="$(cat include/config/kernel.release)"
echo "kernel release: ${kernel_release}"
[ "${kernel_release}" = "${KERNEL_EXPECT}" ] || { echo "error: the tree built ${kernel_release}; this family expects ${KERNEL_EXPECT}" >&2; exit 1; }
make "${CROSS[@]}" INSTALL_MOD_PATH=/kmods INSTALL_MOD_STRIP=1 DEPMOD=true modules_install
cp "common_drivers/arch/arm64/boot/dts/amlogic/${DTB}" "${DTB_ARTIFACT}"
[ ! -f "${HOOKS}/verify.sh" ] || bash "${HOOKS}/verify.sh" "${SRC}" "${DTB_ARTIFACT}"

[ ! -f "${HOOKS}/modules.sh" ] || bash "${HOOKS}/modules.sh" "${SRC}" /kmods "${BOARD_DIR}"

module_dir="/kmods/lib/modules/${kernel_release}"
depmod -b /kmods "${kernel_release}"
for index in modules.dep modules.dep.bin modules.alias modules.alias.bin; do
    test -s "${module_dir}/${index}"
done
for index in modules.softdep modules.symbols; do
    test -f "${module_dir}/${index}"
done
[ ! -f "${HOOKS}/modules-verify.sh" ] || bash "${HOOKS}/modules-verify.sh" "${module_dir}"
# Sorted and with every mtime pinned, so two builds of one tree yield one
# modules.tar (the rockchip and uefi families pack theirs the same way).
tar --sort=name --mtime=@1577836800 --owner=0 --group=0 --numeric-owner \
    -C /kmods -cf /modules.tar lib
