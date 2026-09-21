#!/usr/bin/env bash
# mica-build-side: container. Compile a rockchip board's kernel, modules and
# device tree from the configured tree, and pack what the bundle takes.
#
#   build.sh <source-tree> <expected-kernel-release> <dtb> <dtb-artifact-path> <board-hooks-dir>
#   build.sh --image <source-tree> <expected-kernel-release>
#
# --image relinks only the Image of a tree this script built before, after its
# command line moved to another profile (common/kernel/set-profile.sh): with the
# same make variables Kbuild recompiles only the objects that read
# CONFIG_CMDLINE; the modules and the device tree are those of the first build.
#
# <dtb> is the file under arch/arm64/boot/dts/rockchip/ to build, and
# <dtb-artifact-path> where the compiled tree is copied for the artifact stage.
# The board's verify hook runs last over the built tree and that file.
set -euo pipefail

CROSS=(ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu-)
if [ "${1-}" = --image ]; then
    [ "$#" -eq 3 ] || { echo "usage: build.sh --image <source-tree> <expected-kernel-release>" >&2; exit 1; }
    cd "$2"
    make "${CROSS[@]}" -j"$(nproc)" Image
    [ "$(cat include/config/kernel.release)" = "$3" ] || { echo "error: the relinked tree is $(cat include/config/kernel.release); this family expects $3" >&2; exit 1; }
    exit 0
fi

[ "$#" -eq 5 ] || {
    echo "usage: build.sh <source-tree> <expected-kernel-release> <dtb> <dtb-artifact-path> <board-hooks-dir>" >&2
    exit 1
}
SRC="$1"
KERNEL_EXPECT="$2"
DTB="$3"
DTB_ARTIFACT="$4"
HOOKS="$5"
[ -n "${KERNEL_EXPECT}" ] || {
    echo "error: build.sh was given no expected kernel release. The assertion below would then compare the built release against the empty string and could never hold, which is a different failure from the one it exists to report" >&2
    exit 1
}
[ -n "${DTB}" ] || { echo "error: build.sh was given no device tree to build (KERNEL_DTB in bsp.env)" >&2; exit 1; }

cd "${SRC}"

make "${CROSS[@]}" -j"$(nproc)" Image modules

# vmlinux and System.map: the two files holding the link-time symbol table,
# sized in the log; System.map is exported, vmlinux stays here.
ls -l vmlinux System.map

release="$(cat include/config/kernel.release)"
echo "kernel release: ${release}"
[ "${release}" = "${KERNEL_EXPECT}" ] || {
    echo "error: the tree built ${release}; this family expects ${KERNEL_EXPECT}" >&2
    exit 1
}

make "${CROSS[@]}" INSTALL_MOD_PATH=/kmods INSTALL_MOD_STRIP=1 modules_install
rm -f "/kmods/lib/modules/${release}/build" "/kmods/lib/modules/${release}/source"
tar --sort=name --mtime=@1577836800 --owner=0 --group=0 --numeric-owner \
    -C /kmods -cf /modules.tar lib
printf '%s\n' "${release}" >/kernel.release
ls /kmods/lib/modules/

make "${CROSS[@]}" "rockchip/${DTB}"
cp "arch/arm64/boot/dts/rockchip/${DTB}" "${DTB_ARTIFACT}"

[ ! -f "${HOOKS}/verify.sh" ] || bash "${HOOKS}/verify.sh" "${SRC}" "${DTB_ARTIFACT}"
