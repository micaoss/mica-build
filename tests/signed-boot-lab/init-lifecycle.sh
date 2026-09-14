#!/bin/sh
# mica-build-side: container -- PID 1 in the disposable x64 QEMU guest.
set -u
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs dev /dev
echo "LIFECYCLE date=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if /key-revoke; then
    echo 'LIFECYCLE revoke-probe=complete'
else
    echo 'LIFECYCLE revoke-probe=failed'
fi
exec /init-matrix.sh
