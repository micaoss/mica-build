#!/usr/bin/env bash
# The CX3576-Z's kconfig edits over the committed config, before the shared
# floor is merged: the AIC8800 Wi-Fi instead of the Broadcom and Rockchip
# wireless stacks, the HYM8563 RTC, the heartbeat LED trigger, no Mali400, no
# OP-TEE, autofs for the container engine, and the boot logo.
#
#   configure.sh <source-tree>
set -euo pipefail
cd "$1"
scripts/config --disable WL_ROCKCHIP --disable WIFI_BUILD_MODULE \
               --disable AP6XXX --disable BCMDHD \
               --disable BCMDHD_SDIO --disable BCMDHD_PCIE \
               --enable RFKILL_RK \
               --enable RTC_DRV_HYM8563 \
               --enable LEDS_TRIGGERS \
               --enable LEDS_TRIGGER_HEARTBEAT \
               --disable MALI400 --disable TEE --disable OPTEE \
               --disable ARM_SCMI_TRANSPORT_OPTEE --disable HW_RANDOM_OPTEE \
               --enable AUTOFS_FS \
               --enable LOGO \
               --enable LOGO_LINUX_CLUT224 \
               --disable LOGO_LINUX_MONO \
               --disable LOGO_LINUX_VGA16 \
               --set-str AIC_FW_PATH "/lib/firmware"
