#!/usr/bin/env bash
# mica-build-side: container -- qemu_arm_defconfig with the Mica FIT boot over UBI (common/mica-ubi-boot.c).
#
#   build-mica.sh SOURCE BOOT_TRUST UBI_MTD FIT_UBI_ADDRESS FIT_UBI_LIMIT
#
# BOOT_TRUST is none, and only none: qemu_arm takes its control device tree from QEMU at run time
# (OF_HAS_PRIOR_STAGE), so no required key can be built into it, and the loader checks the FIT's hashes
# (verify=yes) without proving who signed it.
set -euo pipefail
[ "$#" -eq 5 ] || { echo 'usage: build-mica.sh SOURCE BOOT_TRUST UBI_MTD FIT_UBI_ADDRESS FIT_UBI_LIMIT' >&2; exit 1; }
SRC="$1" TRUST="$2" MTD="$3" ADDRESS="$4" LIMIT="$5"
[ "$TRUST" = none ] || { echo "error: BOOT_TRUST '$TRUST'; qemu_arm's control device tree is QEMU's, which carries no required key, so this board's trust is none" >&2; exit 1; }
[[ "$MTD" =~ ^[A-Za-z0-9._-]{1,63}$ ]] || { echo "error: '$MTD' is not an MTD name" >&2; exit 1; }
[[ "$ADDRESS" =~ ^0x[0-9a-fA-F]+$ ]] && [[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo 'error: FIT_UBI_ADDRESS is hexadecimal and FIT_UBI_LIMIT a byte count' >&2; exit 1; }
cd "$SRC"
make qemu_arm_defconfig
# All of pflash1 is the UBI partition: the environment lives nowhere, so no stored command reaches boot. The CFI
# probe starts at the banks' 32-bit width (the device tree's bank-width): probed narrower, each bank reads as one
# 16-bit chip of half the size and half the erase block, and the UBI geometry would not be Linux's. Words are
# programmed one by one: QEMU's pflash times out a buffered program over bytes already written, which is how UBI
# invalidates a header.
scripts/config --enable MICA_UBI_BOOT --set-str MICA_UBI_MTD "$MTD" \
    --set-val MICA_UBI_FIT_ADDRESS "$ADDRESS" --set-val MICA_UBI_FIT_LIMIT "$LIMIT" \
    --enable ENV_IS_NOWHERE --disable ENV_IS_IN_FLASH \
    --disable BOOTSTD --disable BOOTSTD_FULL --disable BOOTSTD_DEFAULTS --disable DISTRO_DEFAULTS --disable EFI_LOADER \
    --disable SAVEENV --disable CMD_SAVEENV --disable CMD_SOURCE --disable CMD_IMPORTENV \
    --disable CMD_BOOTI --disable CMD_BOOTZ --disable LEGACY_IMAGE_FORMAT --disable USE_PREBOOT \
    --enable AUTOBOOT --enable CMDLINE --enable HUSH_PARSER --enable CMD_BOOTD --enable CMD_RUN \
    --disable AUTOBOOT_KEYED --enable USE_BOOTCOMMAND --set-str BOOTCOMMAND micaboot \
    --set-val BOOTDELAY 1 \
    --enable FIT --enable FIT_SIGNATURE --enable FIT_FULL_CHECK \
    --enable MTD --enable DM_MTD --enable MTD_NOR_FLASH --enable FLASH_CFI_MTD --enable SYS_FLASH_CFI_WIDTH_32BIT \
    --disable SYS_FLASH_USE_BUFFER_WRITE \
    --enable MTD_UBI --enable CMD_UBI --disable CMD_UBIFS --disable MTD_UBI_FASTMAP
make olddefconfig
for symbol in MICA_UBI_BOOT ENV_IS_NOWHERE OF_HAS_PRIOR_STAGE FIT FIT_SIGNATURE FIT_FULL_CHECK CMD_BOOTM \
    MTD_UBI CMD_UBI FLASH_CFI_MTD AUTOBOOT CMDLINE HUSH_PARSER CMD_BOOTD CMD_RUN USE_BOOTCOMMAND; do
    grep -qx "CONFIG_${symbol}=y" .config || { echo "error: missing ${symbol}" >&2; exit 1; }
done
for symbol in SYS_FLASH_USE_BUFFER_WRITE ENV_IS_IN_FLASH CMD_SAVEENV CMD_SOURCE CMD_BOOTI CMD_BOOTZ LEGACY_IMAGE_FORMAT \
    USE_PREBOOT AUTOBOOT_KEYED EFI_LOADER BOOTSTD MTD_UBI_FASTMAP; do
    if grep -qx "CONFIG_${symbol}=y" .config; then echo "error: forbidden ${symbol}" >&2; exit 1; fi
done
grep -qx 'CONFIG_BOOTDELAY=1' .config
grep -qx 'CONFIG_BOOTCOMMAND="micaboot"' .config
grep -qx "CONFIG_MICA_UBI_MTD=\"$MTD\"" .config
grep -qx 'CONFIG_SYS_FLASH_CFI_WIDTH=0x4' .config
make -j"$(nproc)" CROSS_COMPILE=arm-linux-gnueabihf-
arm-linux-gnueabihf-nm u-boot | grep -c ' T mica_ubi_boot$' >/dev/null
arm-linux-gnueabihf-nm u-boot | grep -c '_u_boot_list_2_cmd_2_micaboot$' >/dev/null
cp .config mica.config
printf '%s\n' 'MICA_UBI_FIT_FIRMWARE_BUILD_PASS'
