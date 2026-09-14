#!/usr/bin/env bash
# Read named files back out of the DATA partition of the prepared disk, from the
# host, with the guest powered down.
#
#   bash read-data.sh <path-inside-DATA> [...]
#
# This is how the reboot-survival half of the random-seed proof is measured: the
# seed file the guest's shutdown `ExecStop=save` wrote lives on DATA, so its
# bytes can be compared across a power cycle without needing a login. debugfs
# only -- no loop mount, no privilege.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${P1_WORK:-$REPO/.tmp/p1-writable-path-audit}"
mkdir -p "$S"
MICA_PRODUCT="${MICA_PRODUCT:?product name required}"
eval "$(bash "$REPO/tools/product.sh" "$MICA_PRODUCT")"
BOARD_ENV="$BOARD_DIR/board.env"
# shellcheck source=/dev/null
. "$BOARD_ENV"
QDIR="$REPO/_out/products/$MICA_PRODUCT/qemu"
[ -f "$QDIR/disk.img" ] || { echo "error: $QDIR/disk.img not found" >&2; exit 1; }
[ "$#" -gt 0 ] || { echo "usage: $0 <path-inside-DATA> [...]" >&2; exit 2; }

IMAGE="$(bash "$REPO/tools/from.sh" --ref IMAGE_DEBIAN_TRIXIE)"
# mica-build-side: container-block -- sgdisk and debugfs read the DATA partition out of the
# disk copy inside the pinned image; a loop mount on the host would need privileges a test
# should not want
docker run --rm --label ai-agent=true --name "ai-agent-iku9ubdw-readdata-$$" \
    -v "$QDIR:/d:ro" -e "DATA_PARTNUM=${DATA_PARTNUM}" -e "WANT=$*" \
    "$IMAGE" bash -c '
    set -eu
    apt-get update -qq >/dev/null 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        gdisk e2fsprogs >/dev/null 2>&1
    start=$(sgdisk -i "${DATA_PARTNUM}" /d/disk.img | sed -n "s/^First sector: \([0-9]*\).*/\1/p")
    end=$(sgdisk -i "${DATA_PARTNUM}" /d/disk.img | sed -n "s/^Last sector: \([0-9]*\).*/\1/p")
    [ -n "${start}" ] || { echo "error: no DATA partition in the GPT" >&2; exit 1; }
    dd if=/d/disk.img of=/tmp/data.img bs=512 skip="${start}" count="$(( end - start + 1 ))" status=none
    for p in ${WANT}; do
        echo "===== ${p} ====="
        debugfs -R "stat ${p}" /tmp/data.img 2>/dev/null | sed -n "1,6p" | sed "s/^/  /"
        echo "  --- contents ---"
        debugfs -R "cat ${p}" /tmp/data.img 2>/dev/null | sed "s/^/  /"
        echo "  --- sha256 ---"
        debugfs -R "cat ${p}" /tmp/data.img 2>/dev/null | sha256sum | sed "s/^/  /"
    done
'
# mica-build-side: host
