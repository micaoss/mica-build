#!/usr/bin/env bash
# mica-build-side: container -- runs inside the kernel build image (kernel/Dockerfile).
#
# Compile the configured tree once per image profile and pack what the bundle takes.
#
#   build.sh <source-tree> <expected-kernel-release> <profiles> <device tree> <floor fragment> <out>
#
# The first profile is built whole -- zImage and modules, the modules installed and packed as modules.tar --
# and every later one only moves the forced command line (common/kernel/set-profile.sh) and relinks zImage.
# <out>/<profile>/ receives zImage, config, System.map, kernel.release, modules.tar, the device tree (QEMU's,
# recorded under dts/) and the floor fragment. The symbols the board boots on are asserted in the compiled tree.
set -euo pipefail
[ "$#" -eq 6 ] || { echo 'usage: build.sh <source-tree> <expected-kernel-release> <profiles> <device tree> <floor fragment> <out>' >&2; exit 1; }
SRC="$1" EXPECT="$2" PROFILES="$3" DTB="$4" FLOOR="$5" OUT="$6"
cd "${SRC}"
mk() { make ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- "$@"; }
first=""
for profile in ${PROFILES}; do
    bash /bsp/set-profile.sh "${SRC}" "${profile}" ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
    if [ -z "${first}" ]; then
        mk -j"$(nproc)" zImage modules
        release="$(cat include/config/kernel.release)"
        [ "${release}" = "${EXPECT}" ] || { echo "error: the tree reports ${release}; bsp.env expects ${EXPECT}" >&2; exit 1; }
        rm -rf /kmods
        mk INSTALL_MOD_PATH=/kmods INSTALL_MOD_STRIP=1 modules_install
        # Kbuild runs depmod only over modules; this kernel builds everything in, and its index is still written.
        [ -f "/kmods/lib/modules/${release}/modules.dep" ] || depmod -b /kmods "${release}"
        [ -f "/kmods/lib/modules/${release}/modules.builtin" ] && [ -f "/kmods/lib/modules/${release}/modules.dep" ] \
            || { echo "error: modules_install wrote no index for ${release}" >&2; exit 1; }
        rm -f "/kmods/lib/modules/${release}/build" "/kmods/lib/modules/${release}/source"
        tar --sort=name --mtime=@1577836800 --owner=0 --group=0 --numeric-owner -C /kmods -cf /modules.tar lib
        printf '%s\n' "${release}" > /kernel.release
        first="${profile}"
    else
        mk -j"$(nproc)" zImage
    fi
    for option in DM_INIT DM_VERITY SQUASHFS MTD_UBI MTD_UBI_BLOCK UBIFS_FS I6300ESB_WDT CMDLINE_FORCE; do
        grep -q "^CONFIG_${option}=y" include/config/auto.conf || { echo "error: CONFIG_${option} is not =y in the compiled tree" >&2; exit 1; }
    done
    out="${OUT}/${profile}"
    mkdir -p "${out}"
    cp arch/arm/boot/zImage System.map /kernel.release /modules.tar "${DTB}" "${FLOOR}" "${out}/"
    cp .config "${out}/config"
    echo "kernel ${profile}: zImage $(stat -c%s arch/arm/boot/zImage) bytes"
done
[ -n "${first}" ] || { echo 'error: no profile was named' >&2; exit 1; }
