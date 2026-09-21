#!/usr/bin/env bash
# Over the built device tree: it is the BM201 board's, and its watchdog is
# left to userspace to feed at the timeout the lifecycle contract states.
#
#   verify.sh <source-tree> <dtb>
set -euo pipefail
DTB="$2"
compatible="$(fdtget "${DTB}" / compatible)"
[ "${compatible}" = 's7d_s905x5m_bm201' ]
[ "$(fdtget -t u "${DTB}" /soc/apb4@fe000000/watchdog@2100 amlogic,feed_watchdog_mode)" = 0 ]
[ "$(fdtget -t u "${DTB}" /soc/apb4@fe000000/watchdog@2100 timeout-sec)" = 60 ]
