#!/usr/bin/env bash
# Pack the guest userspace, the three init scripts and the payload into one
# uncompressed newc cpio -- the initramfs the kernel under test boots.
#
#   bash tests/signed-boot-lab/build-initramfs.sh [output-name]
#
# amd64 only: it runs the guest image, and this host cannot execute an arm64
# container. The arm64 archive is assembled inside the build instead, by
# Dockerfile.guest-arm64, which images.sh drives on an emulating builder.
#
# `find . -xdev` is what keeps the work directory out of the archive: it is a
# bind mount, so it is another device and the walk stops there -- and /proc,
# /sys and /dev are printed as the empty mount points the guest needs rather
# than descended into.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
lab_require_image "${GUEST_IMAGE}"
OUT="${1:-initramfs.cpio}"
[ -d "${LAB_WORK}/payload" ] || {
    echo "error: ${LAB_WORK}/payload does not exist. Run tests/signed-boot-lab/prepare-payload.sh first" >&2
    exit 1
}
lab_docker_run "${GUEST_IMAGE}" bash -c "
set -eu
cp -a /w/payload /payload
cp /lab/init-dispatch.sh /init
cp /lab/init-matrix.sh /lab/init-switchroot.sh /
chmod +x /init /init-matrix.sh /init-switchroot.sh
cd /
find . -xdev -not -name '${OUT}' | cpio -o -H newc --quiet > /w/${OUT}
ls -la /w/${OUT}
"
