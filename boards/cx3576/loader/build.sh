#!/usr/bin/env bash
# mica-build-side: container -- U-Boot is cross-compiled inside the BSP builder
# image; docs/design/build.md section 0 is why there is no compiler on the host.
#
# Configure and build the CX3576-Z U-Boot, debug variant (ENV_IS_NOWHERE).
#
#   build.sh <source-tree> <rkbin-dir> <ddr-blob> <bl31-blob> <defconfig>
#
# Recovery enters RockUSB; a failed boot falls back to RockUSB. The `mica` A/B
# variant reconfigures this tree and rebuilds it -- see build-mica.sh.
#
# THE adc-keys NODE IS NOT HERE ANY MORE. It was a `printf ... >> "$DTSFILE"`
# appended to arch/arm/dts/rk3576-generic.dts between defconfig and make, where
# the file was found by grepping CONFIG_DEFAULT_DEVICE_TREE out of the resolved
# .config. It is patches/0007 since RFCT-345, applied with the rest of the
# series; the byte comparison against the pre-extraction artefacts is what says
# the move changed nothing.
set -euo pipefail

[ "$#" -eq 5 ] || {
    echo "usage: build.sh <source-tree> <rkbin-dir> <ddr-blob> <bl31-blob> <defconfig>" >&2
    exit 1
}
SRC="$1"
RKBIN="$2"
DDR="${RKBIN}/bin/rk35/$3"
BL31="${RKBIN}/bin/rk35/$4"
DEFCONFIG="$5"

for blob in "${DDR}" "${BL31}"; do
    [ -f "${blob}" ] || {
        echo "error: ${blob} is not in the rkbin checkout. The DDR initialiser and BL31 are vendor binaries this build cannot produce, and a missing one would otherwise surface as a link failure deep in the FIT" >&2
        exit 1
    }
done

cd "${SRC}"

require() {
    grep -q "$1" .config || {
        echo "error: the resolved .config does not match: $1" >&2
        exit 1
    }
}

make "${DEFCONFIG}"

# THE BOARD'S CONFIGURATION, over generic-rk3576_defconfig.
#
#   * RockUSB gadget, and the ADC button that enters it. PREBOOT runs before the
#     boot command, so a held recovery key is read while the LEDs are set.
#   * FIT plus a 128 MiB SYS_BOOTM_LEN, which is what a kernel Image plus its
#     device tree needs room to decompress into.
#   * BOOTCOMMAND clears boot_targets so the device tree's bootdev-order decides,
#     scans, and enters RockUSB if nothing booted -- the rescue path that makes a
#     bad image recoverable without the maskrom pin.
scripts/config --enable CMD_ROCKUSB \
               --enable USB_GADGET \
               --enable USB_FUNCTION_ROCKUSB \
               --enable ADC \
               --enable ADC_ROCKCHIP \
               --enable BUTTON \
               --enable BUTTON_ADC \
               --enable CMD_BUTTON \
               --enable CMD_ADC \
               --enable FIT \
               --enable ZSTD \
               --set-val BOOTDELAY 1 \
               --set-val SYS_BOOTM_LEN 0x8000000 \
               --enable USE_PREBOOT \
               --set-str PREBOOT "led status-blue off; led status-red on; led work on; if button recovery; then echo RECOVERY KEY - entering rockusb; rockusb 0 mmc 0; fi" \
               --set-str BOOTCOMMAND "setenv boot_targets; bootflow scan -lb; echo BOOT FAILED - entering rockusb; rockusb 0 mmc 0"

make olddefconfig

require '^CONFIG_ADC=y'
require '^CONFIG_BUTTON_ADC=y'
require '^CONFIG_CMD_ROCKUSB=y'
require '^CONFIG_USB_FUNCTION_ROCKUSB=y'
require '^CONFIG_FIT=y'
require '^CONFIG_ZSTD=y$'
require '^CONFIG_BOOTDELAY=1$'
require '^CONFIG_SYS_BOOTM_LEN=0x8000000$'
require '^CONFIG_USE_PREBOOT=y'
require '^CONFIG_PREBOOT="led status-blue off; led status-red on; led work on; if button recovery; then echo RECOVERY KEY - entering rockusb; rockusb 0 mmc 0; fi"'
require '^CONFIG_BOOTCOMMAND="setenv boot_targets; bootflow scan -lb; echo BOOT FAILED - entering rockusb; rockusb 0 mmc 0"'
# SPL needs GPIO and the fixed regulator driver to raise the SD rail before it
# probes the card (patches/0005); without these four the second MMC device is
# probed and never answers.
require '^CONFIG_SPL_GPIO=y'
require '^CONFIG_SPL_DM_GPIO=y'
require '^CONFIG_SPL_DM_REGULATOR=y'
require '^CONFIG_SPL_DM_REGULATOR_FIXED=y'
# A zero boot-mode register would make the reboot-to-rockusb handshake write its
# magic nowhere, so the address is required to be non-zero rather than present.
grep -Eq '^CONFIG_ROCKCHIP_BOOT_MODE_REG=0x[1-9a-fA-F][0-9a-fA-F]*$' .config || {
    echo "error: CONFIG_ROCKCHIP_BOOT_MODE_REG is unset or zero, so nothing can record a reboot into rockusb" >&2
    exit 1
}
require '^CONFIG_CMD_USB=y'
require '^CONFIG_USB_STORAGE=y'
require '^CONFIG_USB_XHCI_HCD=y'
require '^CONFIG_GPIO_HOG=y'
require '^CONFIG_CMD_LED=y'
require '^CONFIG_LED_GPIO=y'

make -j"$(nproc)" CROSS_COMPILE=aarch64-linux-gnu- \
    ROCKCHIP_TPL="${DDR}" BL31="${BL31}"

# Each patch's effect, read out of the tree that was just compiled.
grep -q 'case BOOT_LOADER:' arch/arm/mach-rockchip/boot_mode.c
# `| grep -c ... >/dev/null` and not `| grep -q`: -q exits at the first match and
# closes the pipe, so under `set -o pipefail` the pipeline reports FAILURE
# precisely when the pattern is FOUND. In the Dockerfile RUN this lived in, /bin/sh
# ran without pipefail and the inversion was dormant; tests/shell-pipefail-lint.sh
# is the check that says so, and it only sees shell scripts.
grep -A4 'status = usb_add_function' drivers/usb/gadget/f_rockusb.c |
    grep -c 'free(f_rkusb->write_cache)' >/dev/null

# The SD rail and the SPL boot order, read back out of the compiled SPL device
# tree rather than out of the source that produced it.
[ "$(fdtget spl/u-boot-spl.dtb /sdmmc-regulator regulator-name)" = "vcc_sd" ]
fdtget spl/u-boot-spl.dtb /soc/mmc@2a310000 vmmc-supply >/dev/null
[ "$(fdtget spl/u-boot-spl.dtb /chosen u-boot,spl-boot-order)" = \
    "same-as-spl /soc/mmc@2a310000 /soc/mmc@2a330000 /soc/ufshc@2a2d0000" ]
# Textual check only: it pins the DT property, not that the mmc0 alias resolves
# to the eMMC controller. Binding alias to controller needs a semantic check on
# hardware -- recorded no-action.
[ "$(fdtget u-boot.dtb /bootstd bootdev-order)" = "mmc0 mmc1 usb" ]
[ "$(fdtget u-boot.dtb /soc/usb@23400000 dr_mode)" = "host" ]
[ "$(fdtget u-boot.dtb /leds/led-work label)" = "work" ]
[ "$(fdtget u-boot.dtb /leds/led-status-red label)" = "status-red" ]
[ "$(fdtget u-boot.dtb /leds/led-status-red default-state)" = "on" ]
[ "$(fdtget -t x u-boot.dtb /leds/led-status-red gpios | awk '{print $3}')" = "1" ]
[ "$(fdtget u-boot.dtb /leds/led-status-blue label)" = "status-blue" ]
[ "$(fdtget u-boot.dtb /leds/led-status-blue default-state)" = "off" ]
[ "$(fdtget -t x u-boot.dtb /leds/led-status-blue gpios | awk '{print $3}')" = "0" ]

ls -la u-boot-rockchip.bin spl/u-boot-spl.bin u-boot.itb
