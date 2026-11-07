#!/bin/sh
# The digest of what the root packs, minus the release's own stamp: every entry of /runtime (type, mode, owner,
# size, link count, link target, content and file capabilities) and every pack knob, but not /etc/issue and
# /usr/lib/os-release, which name the release that built the root. Two builds with this digest pack the same root
# up to that stamp, so a release reuses the previous release's root component when they match (src/product/build.ts).
#
# Called from stages/compose/90-pack.Dockerfile (pack stage), before the squash. Build arguments read from the
# environment: SQUASHFS_TIME, SQUASHFS_COMPRESSION, MICA_ARCH. Writes /out/rootfs-content.tsv (the listing) and
# /out/rootfs-content.sha256 (its digest).
#
# mica-build-side: container -- run by 90-pack.Dockerfile's pack stage, never on a host.

set -eu
cd /runtime
{
    echo "pack ${MICA_ARCH} ${SQUASHFS_COMPRESSION} ${SQUASHFS_TIME} $(mksquashfs -version 2>/dev/null | head -n1)"
    find . -xdev -mindepth 1 \( -path ./etc/issue -o -path ./usr/lib/os-release \) -prune -o \
        -printf '%y %m %U %G %n %s %p -> %l\n' | LC_ALL=C sort
    find . -xdev -type f ! -path ./etc/issue ! -path ./usr/lib/os-release -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
    getcap -r . 2>/dev/null | LC_ALL=C sort
} > /out/rootfs-content.tsv
sha256sum < /out/rootfs-content.tsv | cut -d' ' -f1 > /out/rootfs-content.sha256
