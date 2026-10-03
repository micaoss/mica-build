#!/usr/bin/env bash
# After depmod: each out-of-tree module is in the indexed set exactly once.
#
#   modules-verify.sh <module-dir>
set -euo pipefail
module_dir="$1"
for module in skykirin_ht1628.ko skw_sdio.ko skw.ko; do
    count="$(find "${module_dir}" -type f -name "${module}" | wc -l)"
    [ "${count}" -eq 1 ] || { echo "expected one ${module} in modules.tar, found ${count}" >&2; exit 1; }
done
