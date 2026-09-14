#!/bin/sh
# Squash the root, with every knob that would otherwise vary between builds pinned.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.
# Build arguments read from the environment: SQUASHFS_TIME.
#
# mica-build-side: container -- run by 90-pack.Dockerfile's pack stage, never on a host.

set -eu
test -n "${SQUASHFS_TIME}"
[ ! -e /runtime/var/cache/ldconfig/aux-cache ] || {
    echo "error: /runtime/var/cache/ldconfig/aux-cache survived final composition" >&2
    exit 1
}
[ -s /runtime/etc/ld.so.cache ] || {
    echo "error: /runtime/etc/ld.so.cache is missing or empty" >&2
    exit 1
}
[ -x /runtime/usr/sbin/ldconfig ] || {
    echo "error: /runtime/usr/sbin/ldconfig is missing or not executable" >&2
    exit 1
}
mksquashfs /runtime /out/rootfs.squashfs \
    -comp zstd -Xcompression-level 19 \
    -noappend -no-exports \
    -mkfs-time "${SQUASHFS_TIME}" -all-time "${SQUASHFS_TIME}" \
    -processors 1
