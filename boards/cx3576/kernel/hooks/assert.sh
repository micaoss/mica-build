#!/usr/bin/env bash
# What the resolved CX3576-Z configuration must and must not carry, over and
# above the shared floor: the root and container filesystems, the display
# console with the logo, the AIC8800 Wi-Fi with its firmware path, the board
# peripherals, the USB gadget stack the console and mass-storage modes need,
# and the ARM64 crypto extensions dm-verity hashes with.
#
#   assert.sh <source-tree>
set -euo pipefail
cd "$1"
require() {
    grep -q "$1" .config || {
        echo "error: the resolved .config does not match: $1" >&2
        exit 1
    }
}
refuse() {
    ! grep -q "$1" .config || {
        echo "error: the resolved .config matches, and must not: $1" >&2
        exit 1
    }
}
require "^CONFIG_SQUASHFS_ZSTD=y"
require "^CONFIG_OVERLAY_FS=y"
require "^CONFIG_MEMCG=y"
require "^CONFIG_FRAMEBUFFER_CONSOLE=y"
require "^CONFIG_DRM_FBDEV_EMULATION=y"
require "^CONFIG_AIC_WLAN_SUPPORT=y"
require '^CONFIG_AIC_FW_PATH="/lib/firmware"'
require '^CONFIG_RFKILL_RK=y'
require '^CONFIG_RTC_DRV_HYM8563=y'
require '^CONFIG_LEDS_TRIGGER_HEARTBEAT=y'
require '^# CONFIG_WL_ROCKCHIP is not set'
refuse '^CONFIG_AP6XXX='
refuse '^CONFIG_BCMDHD='

require '^CONFIG_LOGO=y'
require '^CONFIG_LOGO_LINUX_CLUT224=y'
refuse '^CONFIG_FRAMEBUFFER_CONSOLE_DEFERRED_TAKEOVER=y'

for option in \
    BLK_DEV_SD CONFIGFS_FS HID_GENERIC INPUT_EVDEV \
    SCSI USB_CONFIGFS USB_CONFIGFS_ACM USB_DWC3 \
    USB_DWC3_DUAL_ROLE USB_F_ACM USB_GADGET USB_HID \
    USB_LIBCOMPOSITE USB_OTG USB_STORAGE USB_U_SERIAL \
    CRYPTO_AES_ARM64_CE_BLK; do
    grep -q "^CONFIG_${option}=y" .config || {
        echo "missing cx3576 board kernel option: CONFIG_${option}=y" >&2
        exit 1
    }
done
