#!/usr/bin/env bash
# Over the built CX3576-Z tree: every board patch left its mark in the source
# that was compiled (a patch that applied to nothing is a patch that changed
# nothing), the logo is read-only data retained after init, and the device
# tree carries the status LEDs as the boot firmware and the LED service expect
# them.
#
#   verify.sh <source-tree> <dtb>
set -euo pipefail
SRC="$1"
DTB="$2"
cd "${SRC}"
grep -qF 'module_param(yt8531_stock_init, bool, 0444);' drivers/net/phy/motorcomm.c
grep -qF 'obj-$(CONFIG_AIC_WLAN_SUPPORT) += aic8800_sdio/' drivers/net/wireless/Makefile
grep -qF 'BUILD_DATE=$(shell date -u -d' drivers/gpu/arm/mali400/mali/Kbuild
grep -qF 'dtb-$(CONFIG_ARCH_ROCKCHIP) += rk3576-cx3576z.dtb' \
    arch/arm64/boot/dts/rockchip/Makefile
grep -qF 'using fixed clock rates, devfreq is disabled' \
    drivers/video/rockchip/mpp/mpp_rkvenc2.c
grep -q '^CONFIG_LEDS_TRIGGER_HEARTBEAT=y' include/config/auto.conf
grep -qF 'fbcon_show_idle_logo(vc, info)' drivers/video/fbdev/core/fbcon.c
grep -qF 'fbcon_update_vcs(info, true);' drivers/gpu/drm/rockchip/rockchip_drm_fb.c
logo_symbols="$(aarch64-linux-gnu-objdump -t drivers/video/logo/logo_linux_clut224.o)"
for symbol in logo_linux_clut224 logo_linux_clut224_data logo_linux_clut224_clut; do
    awk -v symbol="${symbol}" '
        $NF == symbol && $4 ~ /^\.rodata($|\.)/ { found = 1; print }
        END { exit !found }
    ' <<<"${logo_symbols}"
done
unset logo_symbols
[ "$(fdtget "${DTB}" /leds/status-red label)" = "status-red" ]
[ "$(fdtget "${DTB}" /leds/status-red default-state)" = "on" ]
[ "$(fdtget -t x "${DTB}" /leds/status-red gpios | awk '{print $3}')" = "1" ]
[ "$(fdtget "${DTB}" /leds/status-blue label)" = "status-blue" ]
[ "$(fdtget "${DTB}" /leds/status-blue default-state)" = "off" ]
[ "$(fdtget -t x "${DTB}" /leds/status-blue gpios | awk '{print $3}')" = "0" ]
