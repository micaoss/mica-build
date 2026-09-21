#!/usr/bin/env bash
# The S905X5M's out-of-tree modules, built against the compiled tree and
# installed under the module directory before depmod indexes them.
#
#   modules.sh <source-tree> <install-root> <board-dir>
#
# The front panel: the vendor Android 5.15 tree carries an HT1628 driver for
# this exact panel, but it uses obsolete integer GPIO and character-device
# APIs. The bounded 6.12 port is a separate module so it does not modify
# Amlogic's aggregate amlogic-led.ko for every board.
#
# Seekwave SWT6621/EA6621QT combo: Wi-Fi over SDIO, Bluetooth sharing that
# same bus. The board DTS names brcm,bcm4329-fmac, inherited from the
# reference design, but the real part is this one and its driver lives out of
# tree, under kernel/third rather than fetched during the build, so the build
# does not depend on a third-party repository staying reachable and the code
# can be patched here. gcc, not clang: CONFIG_GCC_PLUGINS=y cannot work under
# clang, and CONFIG_MODVERSIONS=y would reject a mismatched module at insmod
# time. skwifi links against symbols exported by the platform driver, so the
# bsp half is built first and its Module.symvers handed to the second pass.
# CONFIG_SKW_BT is deliberately not set: it would hand HCI to Seekwave's own
# Bluetooth module, which is not in this repository; unset, the driver
# creates /dev/BTDATA for BlueZ to attach.
set -euo pipefail
SRC="$1"
KMODS="$2"
BOARD_DIR="$3"
CROSS=(ARCH=arm64 CROSS_COMPILE="${CROSS_COMPILE-}")
kver="$(cat "${SRC}/include/config/kernel.release")"
extra="${KMODS}/lib/modules/${kver}/extra"
mkdir -p "${extra}"

cp -a "${BOARD_DIR}/kernel/front-panel" /front-panel
make -C "${SRC}" "${CROSS[@]}" M=/front-panel clean
make -C "${SRC}" "${CROSS[@]}" M=/front-panel -j"$(nproc)" modules
cp /front-panel/skykirin_ht1628.ko "${extra}/skykirin_ht1628.ko"
test -s "${extra}/skykirin_ht1628.ko"
modinfo -F alias "${extra}/skykirin_ht1628.ko" | grep -c -Fx 'of:N*T*Cskykirin-ht1628C*' >/dev/null

cp -a "${BOARD_DIR}/kernel/third/seekwave" /skw
make -C /skw "${CROSS[@]}" KERNEL_SRC="${SRC}" M=/skw -j"$(nproc)"
find /skw/drivers -name '*.ko' -exec cp {} "${extra}/" \;
ls -la "${extra}/"
test -f "${extra}/skw_sdio.ko"
test -f "${extra}/skw.ko"
