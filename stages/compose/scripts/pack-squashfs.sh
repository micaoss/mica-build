#!/bin/sh
# Squash the root, with every knob that would otherwise vary between builds pinned.
#
# Called from stages/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.
# Build arguments read from the environment: SQUASHFS_TIME, SQUASHFS_COMPRESSION (the board's ROOTFS_COMPRESSION).
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
# zstd is every board's unless it says xz: 1 MiB blocks, the whole block as dictionary and, for an x86 root, the
# x86 branch filter, about a fifth smaller than zstd 19 and slower to read.
# The filter follows the root's architecture (MICA_ARCH), not this stage's, which runs on the build platform. An
# arm64 root has none: trixie's squashfs-tools 4.6 knows no arm64 branch filter, and its 32-bit arm one does not
# match A64 code.
case "${SQUASHFS_COMPRESSION}" in
zstd) compression="-comp zstd -Xcompression-level 19" ;;
xz)
    case "${MICA_ARCH:-}" in
    amd64) compression="-comp xz -b 1M -Xdict-size 100% -Xbcj x86" ;;
    arm64) compression="-comp xz -b 1M -Xdict-size 100%" ;;
    *) echo "error: MICA_ARCH is '${MICA_ARCH:-}'; the xz branch filter follows the root's architecture, amd64 or arm64" >&2; exit 1 ;;
    esac ;;
*) echo "error: SQUASHFS_COMPRESSION is '${SQUASHFS_COMPRESSION}'; it is zstd or xz" >&2; exit 1 ;;
esac
mksquashfs /runtime /out/rootfs.squashfs \
    ${compression} \
    -noappend -no-exports \
    -mkfs-time "${SQUASHFS_TIME}" -all-time "${SQUASHFS_TIME}" \
    -processors 1
