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
# zstd is every board's unless it says xz: 1 MiB blocks, the whole block as dictionary and the architecture's
# branch filter, about a fifth smaller than zstd 19 and slower to read (mica:docs/plan/20260926-0930-mini-images-on-128-mb.md).
case "${SQUASHFS_COMPRESSION}" in
zstd) compression="-comp zstd -Xcompression-level 19" ;;
xz)
    case "$(uname -m)" in
    x86_64) bcj=x86 ;;
    aarch64) bcj=arm64 ;;
    *) echo "error: no xz branch filter for $(uname -m)" >&2; exit 1 ;;
    esac
    compression="-comp xz -b 1M -Xdict-size 100% -Xbcj ${bcj}" ;;
*) echo "error: SQUASHFS_COMPRESSION is '${SQUASHFS_COMPRESSION}'; it is zstd or xz" >&2; exit 1 ;;
esac
mksquashfs /runtime /out/rootfs.squashfs \
    ${compression} \
    -noappend -no-exports \
    -mkfs-time "${SQUASHFS_TIME}" -all-time "${SQUASHFS_TIME}" \
    -processors 1
