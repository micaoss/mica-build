#!/usr/bin/env bash
# Write files into the DATA partition of the uefi-x64 disk copy before booting it.
#
#   bash seed-data.sh <local-file> <path-inside-DATA> [...]
S="${P1_WORK:-$REPO/.tmp/p1-writable-path-audit}"
mkdir -p "$S"
#
# For probe inputs that must already be on DATA when the audit boots.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
MICA_PRODUCT="${MICA_PRODUCT:?product name required}"
eval "$(bash "$REPO/bin/bun.sh" src/cli.ts product "$MICA_PRODUCT")"
BOARD_ENV="$BOARD_DIR/board.env"
# shellcheck source=/dev/null
. "$BOARD_ENV"
OUT_DIR="$REPO/_out/products/$MICA_PRODUCT"
DISK="$OUT_DIR/qemu/disk.img"
[ -f "$DISK" ] || { echo "error: $DISK not found; prepare the disk first" >&2; exit 1; }
[ "$#" -gt 0 ] && [ $(( $# % 2 )) -eq 0 ] || { echo "usage: $0 <local-file> <path-inside-DATA> [...]" >&2; exit 2; }

WORK="$OUT_DIR/.seed-data"
rm -rf "$WORK"; mkdir -p "$WORK/files"
trap 'rm -rf "$WORK"' EXIT
: >"$WORK/manifest"
n=0
while [ "$#" -gt 0 ]; do
    src="$1"; dst="$2"; shift 2
    [ -f "$src" ] || { echo "error: $src not found" >&2; exit 1; }
    case "$dst" in /*) ;; *) echo "error: '$dst' must be absolute inside DATA" >&2; exit 1 ;; esac
    cp "$src" "$WORK/files/f$n"
    printf '%s %s\n' "f$n" "$dst" >>"$WORK/manifest"
    n=$(( n + 1 ))
done

IMAGE="$(bash "${REPO}/bin/bun.sh" src/cli.ts from --ref upstream:debian:trixie-slim)"
# mica-build-side: container-block -- sgdisk and debugfs write the DATA partition of the
# disk copy inside the pinned image; a loop mount on the host would need privileges a test
# should not want
docker run --rm --label ai-agent=true --name "ai-agent-iku9ubdw-seeddata-$$" \
    -v "$WORK:/w" -v "$OUT_DIR/qemu:/d" \
    -e "DATA_PARTNUM=${DATA_PARTNUM}" \
    "$IMAGE" bash -c '
    set -eu
    apt-get update -qq >/dev/null 2>&1
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
        gdisk e2fsprogs >/dev/null 2>&1
    cd /w
    start=$(sgdisk -i "${DATA_PARTNUM}" /d/disk.img | sed -n "s/^First sector: \([0-9]*\).*/\1/p")
    end=$(sgdisk -i "${DATA_PARTNUM}" /d/disk.img | sed -n "s/^Last sector: \([0-9]*\).*/\1/p")
    [ -n "${start}" ] || { echo "error: no DATA partition in the GPT" >&2; exit 1; }
    count=$(( end - start + 1 ))
    dd if=/d/disk.img of=data.img bs=512 skip="${start}" count="${count}" status=none
    while read -r local dst; do
        dir="$(dirname "${dst}")"
        acc=""
        IFS=/ read -ra parts <<<"${dir#/}"
        for p in "${parts[@]}"; do
            [ -n "${p}" ] || continue
            acc="${acc}/${p}"
            debugfs -w -R "mkdir ${acc}" data.img >/dev/null 2>&1 || true
        done
        debugfs -w -R "rm ${dst}" data.img >/dev/null 2>&1 || true
        debugfs -w -R "write /w/files/${local} ${dst}" data.img >/dev/null 2>&1
        debugfs -R "stat ${dst}" data.img 2>/dev/null | grep -c "Inode:" >/dev/null || {
            echo "error: ${dst} was not written into DATA" >&2; exit 1; }
        echo "  seeded DATA:${dst}"
    done </w/manifest
    e2fsck -fp data.img >/dev/null 2>&1 || true
    dd if=data.img of=/d/disk.img bs=512 seek="${start}" conv=notrunc status=none
'
# mica-build-side: host
echo "DATA seeded in ${DISK##*/}"
