#!/usr/bin/env bash
# Over the built device tree: it is the BM201 board's, and its watchdog is
# left to userspace to feed at the timeout the lifecycle contract states; and
# the board's interface declarations agree with its device tree source
# (common/kernel/dts-interfaces-check.py).
#
#   verify.sh <source-tree> <dtb>
set -euo pipefail
SRC="$1"
DTB="$2"
BOARD="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compatible="$(fdtget "${DTB}" / compatible)"
[ "${compatible}" = 's7d_s905x5m_bm201' ]
[ "$(fdtget -t u "${DTB}" /soc/apb4@fe000000/watchdog@2100 amlogic,feed_watchdog_mode)" = 0 ]
[ "$(fdtget -t u "${DTB}" /soc/apb4@fe000000/watchdog@2100 timeout-sec)" = 60 ]
python3 "${BOARD}/../common/kernel/dts-interfaces-check.py" \
    "${SRC}/common_drivers/arch/arm64/boot/dts/amlogic/s7d_s905x5m_m100.dts" \
    "${BOARD}/package/overlay/usr/share/mica/board/interfaces.json"
