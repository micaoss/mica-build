#!/usr/bin/env bash
# mica-build-side: container -- fixed signed FIT policy and public boot anchor.
set -euo pipefail
[ "$#" -eq 5 ] || { echo 'usage: build-mica.sh SOURCE RKBIN DDR BL31 PUBLIC_CERTIFICATE' >&2; exit 1; }
SRC="$1"
DDR="$2/bin/rk35/$3"
BL31="$2/bin/rk35/$4"
CERTIFICATE="$5"
TOOLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SRC"
! grep -q 'PRIVATE KEY' "$CERTIFICATE"
scripts/config --enable MICA_FILE_BOOT --enable ENV_IS_NOWHERE \
    --disable BOOTSTD --disable BOOTSTD_DEFAULTS --disable DISTRO_DEFAULTS \
    --enable EFI_PARTITION --enable SUPPORT_RAW_INITRD \
    --disable ENV_IS_IN_MMC --disable ENV_REDUNDANT --disable ENV_REDUNDANT_UPGRADE \
    --disable SAVEENV --disable CMD_SAVEENV --disable CMD_SOURCE --disable CMD_IMPORTENV \
    --disable CMD_BOOTI --disable LEGACY_IMAGE_FORMAT --disable USE_PREBOOT \
    --enable AUTOBOOT --enable CMDLINE --enable HUSH_PARSER --enable CMD_BOOTD --enable CMD_RUN \
    --disable AUTOBOOT_KEYED --enable USE_BOOTCOMMAND --set-str BOOTCOMMAND micaboot \
    --set-val BOOTDELAY 1 \
    --enable FIT --enable FIT_SIGNATURE --enable FIT_FULL_CHECK --enable ZSTD \
    --enable IMAGE_SIGN_INFO --enable RSA --enable RSA_VERIFY --enable CMD_BOOTM \
    --enable FS_EXT4 --enable WDT --enable WATCHDOG --enable DESIGNWARE_WATCHDOG \
    --set-val WATCHDOG_TIMEOUT_MSECS 120000
make olddefconfig
for symbol in MICA_FILE_BOOT ENV_IS_NOWHERE FIT FIT_SIGNATURE FIT_FULL_CHECK ZSTD \
    IMAGE_SIGN_INFO RSA RSA_VERIFY CMD_BOOTM FS_EXT4 WDT WATCHDOG DESIGNWARE_WATCHDOG \
    AUTOBOOT CMDLINE HUSH_PARSER CMD_BOOTD CMD_RUN USE_BOOTCOMMAND; do
    grep -qx "CONFIG_${symbol}=y" .config || { echo "error: missing ${symbol}" >&2; exit 1; }
done
for symbol in ENV_IS_IN_MMC ENV_REDUNDANT_UPGRADE CMD_SAVEENV CMD_SOURCE CMD_BOOTI \
    LEGACY_IMAGE_FORMAT USE_PREBOOT AUTOBOOT_KEYED SILENT_CONSOLE BOOT_RETRY; do
    if grep -qx "CONFIG_${symbol}=y" .config; then echo "error: forbidden ${symbol}" >&2; exit 1; fi
done
# Keep the standard development console entry before the signed boot transaction.
grep -qx 'CONFIG_BOOTDELAY=1' .config
grep -qx 'CONFIG_BOOTCOMMAND="micaboot"' .config
bash "$TOOLS_DIR/tests/autoboot.sh" "$SRC"
bash "$TOOLS_DIR/tests/watchdog.sh" "$SRC"
make -j"$(nproc)" CROSS_COMPILE=aarch64-linux-gnu- ROCKCHIP_TPL="$DDR" BL31="$BL31"
bash "$TOOLS_DIR/embed-trust.sh" u-boot.dtb "$CERTIFICATE" mica-control.dtb "$SRC/tools"
make -j"$(nproc)" CROSS_COMPILE=aarch64-linux-gnu- ROCKCHIP_TPL="$DDR" BL31="$BL31" EXT_DTB="$SRC/mica-control.dtb"
cmp u-boot.dtb mica-control.dtb
# A control-FDT override must not skip the configured countdown or native CLI.
if fdtget -p u-boot.dtb /config 2>/dev/null | grep -Ec '^(bootdelay|bootcmd|bootsecure)$' >/dev/null; then
    echo 'error: control FDT overrides the standard autoboot console' >&2
    exit 1
fi
wdt_node=/soc/watchdog@2ace0000
[ "$(fdtget -t s -d okay u-boot.dtb "$wdt_node" status)" = okay ]
[ "$(fdtget -t s u-boot.dtb "$wdt_node" compatible)" = 'rockchip,rk3576-wdt snps,dw-wdt' ]
[ "$(fdtget -t s u-boot.dtb "$wdt_node" clock-names)" = 'tclk pclk' ]
[ "$(stat -c%s u-boot-rockchip.bin)" -le 16744448 ]
aarch64-linux-gnu-nm u-boot | grep -c ' T mica_file_boot$' >/dev/null
aarch64-linux-gnu-nm u-boot | grep -c ' _u_boot_list_2_cmd_2_micaboot$' >/dev/null
cp .config mica.config
printf '%s\n' 'MICA_SIGNED_FIT_FIRMWARE_BUILD_PASS'
