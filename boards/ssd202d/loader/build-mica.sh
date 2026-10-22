#!/usr/bin/env bash
# mica-build-side: container -- the SSD202D loader: the SPL and U-Boot proper from the MStar fork (its
# mstar_infinity2m_gw302_defconfig) with the Mica FIT boot over UBI (common/mica-ubi-boot.c), packed into the
# image of flash.tsv's loader region; the FIT host tools from mainline U-Boot.
#
#   build-mica.sh SOURCE TOOLS_SOURCE BOOT_TRUST UBI_MTD FIT_UBI_ADDRESS FIT_UBI_LIMIT
#
# BOOT_TRUST is none, and only none: the vendor IPL loads the SPL without checking who signed it, so a required
# key built into U-Boot proper would prove nothing; the loader checks the FIT's hashes (verify=yes).
#
# The fork has no tools/fdt_add_pubkey, which the FIT packager runs, so the host tools come from TOOLS_SOURCE.
set -euo pipefail
[ "$#" -eq 6 ] || { echo 'usage: build-mica.sh SOURCE TOOLS_SOURCE BOOT_TRUST UBI_MTD FIT_UBI_ADDRESS FIT_UBI_LIMIT' >&2; exit 1; }
SRC="$1" TOOLS="$2" TRUST="$3" MTD="$4" ADDRESS="$5" LIMIT="$6"
[ "$TRUST" = none ] || { echo "error: BOOT_TRUST '$TRUST'; the vendor IPL loads the SPL unchecked, so this board's trust is none" >&2; exit 1; }
[ "$MTD" = ubi ] || { echo "error: UBI_MTD '$MTD'; MTDPARTS_DEFAULT below names the UBI partition ubi" >&2; exit 1; }
[[ "$ADDRESS" =~ ^0x[0-9a-fA-F]+$ ]] && [[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo 'error: FIT_UBI_ADDRESS is hexadecimal and FIT_UBI_LIMIT a byte count' >&2; exit 1; }

# flash.tsv's loader region, 0x200000-0x47FFFF: the SPL in the vendor IPL's two IPL_CUST slots (three blocks
# each, the vendor IPL skips bad blocks inside a slot), then U-Boot proper A and B, six blocks each (the SPL
# skips bad blocks inside a copy's region), then two spare blocks. Offsets are the region's.
REGION=0x280000 SPL_A=0x0 SPL_B=0x60000 UBOOT_A=0xc0000 UBOOT_B=0x180000 UBOOT_SIZE=0xc0000 BLOCK=0x20000
LOADER_BASE=0x200000
OFFS_A=$(printf '0x%x' $((LOADER_BASE + UBOOT_A))) OFFS_B=$(printf '0x%x' $((LOADER_BASE + UBOOT_B)))

cd "$SRC"
make mstar_infinity2m_gw302_defconfig
# The environment lives nowhere, so no stored command reaches boot. The SPL loads U-Boot proper raw, not from
# UBI; MTDPARTS_DEFAULT is flash.tsv's layout. 2022.07 has no scripts/config; mainline's is the same standalone script.
"$TOOLS/scripts/config" --file .config --enable MICA_UBI_BOOT --set-str MICA_UBI_MTD "$MTD" \
    --set-val MICA_UBI_FIT_ADDRESS "$ADDRESS" --set-val MICA_UBI_FIT_LIMIT "$LIMIT" \
    --disable SPL_UBI --enable SPL_SPINAND_RAW \
    --set-val SPL_SPINAND_RAW_OFFS "$OFFS_A" --set-val SPL_SPINAND_RAW_OFFS_REDUND "$OFFS_B" \
    --set-val SPL_SPINAND_RAW_SIZE "$UBOOT_SIZE" --enable SPL_SPI_NAND_SUPPORT_GIGADEVICE \
    --set-str MTDPARTS_DEFAULT 'spi-nand0:2048k(vendor)ro,2560k(loader),-(ubi)' \
    --enable ENV_IS_NOWHERE --disable ENV_IS_IN_UBI \
    --disable BOOTSTD --disable DISTRO_DEFAULTS --disable EFI_LOADER \
    --disable SAVEENV --disable CMD_SAVEENV --disable CMD_SOURCE --disable CMD_IMPORTENV \
    --disable CMD_BOOTI --disable CMD_BOOTZ --disable LEGACY_IMAGE_FORMAT --disable USE_PREBOOT \
    --enable AUTOBOOT --enable CMDLINE --enable HUSH_PARSER --enable CMD_BOOTD --enable CMD_RUN \
    --disable AUTOBOOT_KEYED --enable USE_BOOTCOMMAND --set-str BOOTCOMMAND micaboot \
    --set-val BOOTDELAY 1 \
    --enable FIT --enable FIT_SIGNATURE --enable FIT_FULL_CHECK \
    --enable MTD --enable DM_MTD --enable MTD_SPI_NAND \
    --enable MTD_UBI --enable CMD_UBI --disable CMD_UBIFS --disable MTD_UBI_FASTMAP
make olddefconfig
for symbol in MICA_UBI_BOOT ENV_IS_NOWHERE FIT FIT_SIGNATURE FIT_FULL_CHECK CMD_BOOTM MTD_UBI CMD_UBI MTD_SPI_NAND \
    AUTOBOOT CMDLINE HUSH_PARSER CMD_BOOTD CMD_RUN USE_BOOTCOMMAND MSTAR_IPL SPL_SPI_NAND_SUPPORT \
    SPL_SPI_NAND_SUPPORT_GIGADEVICE SPL_SPINAND_RAW SPL_LEGACY_IMAGE_FORMAT SPL_LEGACY_IMAGE_CRC_CHECK; do
    grep -qx "CONFIG_${symbol}=y" .config || { echo "error: missing ${symbol}" >&2; exit 1; }
done
for symbol in SPL_UBI ENV_IS_IN_UBI CMD_SAVEENV CMD_SOURCE CMD_BOOTI CMD_BOOTZ LEGACY_IMAGE_FORMAT USE_PREBOOT \
    AUTOBOOT_KEYED EFI_LOADER MTD_UBI_FASTMAP; do
    if grep -qx "CONFIG_${symbol}=y" .config; then echo "error: forbidden ${symbol}" >&2; exit 1; fi
done
for line in 'CONFIG_BOOTDELAY=1' 'CONFIG_BOOTCOMMAND="micaboot"' "CONFIG_MICA_UBI_MTD=\"$MTD\"" \
    "CONFIG_SPL_SPINAND_RAW_OFFS=$OFFS_A" "CONFIG_SPL_SPINAND_RAW_OFFS_REDUND=$OFFS_B" \
    "CONFIG_SPL_SPINAND_RAW_SIZE=$UBOOT_SIZE" "CONFIG_MTDPARTS_DEFAULT=\"spi-nand0:2048k(vendor)ro,2560k(loader),-(ubi)\""; do
    grep -qxF "$line" .config || { echo "error: .config lacks $line" >&2; exit 1; }
done
make -j"$(nproc)" CROSS_COMPILE=arm-linux-gnueabihf-
# Both stages are built with LTO, which inlines or renames functions, so each is found by its linker-list entry.
# The symbols go through files: grep -q quitting early would fail nm's pipe under pipefail.
arm-linux-gnueabihf-nm u-boot > u-boot.syms
arm-linux-gnueabihf-nm spl/u-boot-spl > spl.syms
grep -q '_u_boot_list_2_cmd_2_micaboot$' u-boot.syms || { echo 'error: u-boot has no micaboot command' >&2; exit 1; }
grep -q 'spl_image_loader.*spl_spinand_raw_load_image' spl.syms ||
    { echo 'error: the SPL has no raw SPI NAND method' >&2; grep -i 'spl_image_loader' spl.syms >&2; exit 1; }
cp .config mica.config

# The SPL in the IPL_CUST header (`make ipl`) must fit its 16-bit length field, U-Boot proper its region less one
# bad block.
spl=$(stat -c %s ipl) uboot=$(stat -c %s u-boot.img)
[ "$(head -c 8 ipl | tail -c 4)" = IPLC ] || { echo 'error: ipl has no IPLC header' >&2; exit 1; }
[ "$spl" -le 65535 ] || { echo "error: the SPL is $spl bytes, more than the IPL header's length field holds" >&2; exit 1; }
[ "$uboot" -le $((UBOOT_SIZE - BLOCK)) ] || { echo "error: u-boot.img is $uboot bytes, more than its region less a block" >&2; exit 1; }
# Erased flash reads 0xff: the image is the whole region, so writing it erases what it does not fill.
head -c $((REGION)) /dev/zero | tr '\000' '\377' > loader.bin
for at in "ipl $SPL_A" "ipl $SPL_B" "u-boot.img $UBOOT_A" "u-boot.img $UBOOT_B"; do
    set -- $at
    dd if="$1" of=loader.bin bs=1 seek=$(($2)) conv=notrunc status=none
done
[ "$(stat -c %s loader.bin)" -eq $((REGION)) ]
printf 'loader.bin: SPL %d bytes at +%#x and +%#x, u-boot.img %d bytes at +%#x and +%#x\n' \
    "$spl" $((SPL_A)) $((SPL_B)) "$uboot" $((UBOOT_A)) $((UBOOT_B))

cd "$TOOLS"
make tools-only_defconfig
make -j"$(nproc)" tools-only
for tool in mkimage fdt_add_pubkey fit_check_sign dumpimage; do
    [ -x "tools/$tool" ] || { echo "error: tools/$tool was not built" >&2; exit 1; }
done
printf '%s\n' 'MICA_UBI_FIT_FIRMWARE_BUILD_PASS'
