#!/usr/bin/env bash
# What the resolved S905X5M configuration must carry beyond the shared floor
# and its own fragments: the forced command line the signed-boot fragment
# states, and the runtime facilities the container engine and hwinit need.
# The first lookup is a positive control against the final .config: only
# after it succeeds does a missing requirement count as evidence rather than
# as a broken search.
#
#   assert.sh <source-tree> <board-config-dir>
set -euo pipefail
cd "$1"
CONFIG_DIR="$2"
grep -Fxf "${CONFIG_DIR}/signed-boot.fragment" .config | grep -c '^CONFIG_CMDLINE=' >/dev/null
for line in \
    CONFIG_DEVTMPFS=y CONFIG_SECCOMP=y CONFIG_CGROUPS=y \
    CONFIG_NF_TABLES=y CONFIG_CONFIGFS_FS=y; do
    grep -Fqx -- "${line}" .config || { echo "missing board kernel option: ${line}" >&2; exit 1; }
done
