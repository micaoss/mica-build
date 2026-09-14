#!/bin/sh
# Diff the packed setuid/setgid inventory against the source tree it was made from.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.
#
# mica-build-side: container -- run by 90-pack.Dockerfile's pack stage, never on a host.

set -eu
unsquashfs -lln /out/rootfs.squashfs \
    | awk 'substr($1,4,1) ~ /[sS]/ || substr($1,7,1) ~ /[sS]/ {                  split($2, o, "/"); path = $NF; sub(/^squashfs-root\/?/, "", path);                  if (path != "") printf "%s %s %s %s\n", $1, o[1], o[2], path }' \
    | sort > /out/privileged-pkg.txt
if ! diff -u /out/privileged-src.txt /out/privileged-pkg.txt; then
    echo "error: packing changed setuid/setgid ownership or modes; the squashfs must preserve the source tree's uid/gid (check for -all-root / -force-uid / -force-gid)" >&2
    exit 1
fi
{ echo
  echo "== setuid/setgid (mode uid gid path; identical in source tree and packed image) =="
  cat /out/privileged-pkg.txt
} >> /out/rootfs-report.txt
