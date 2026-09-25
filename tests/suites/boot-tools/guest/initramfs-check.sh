#!/bin/bash
# mica-build-side: container -- real static x64 inputs; no target execution.
# The startup initramfs of one mica-runkit, packed twice in the boot-tools
# image: /src the checkout, /input the runkit and a boot.json, /output scratch.
set -euo pipefail
REPO=${1:?repository root}
WORK=$(mktemp -d)
trap 'rm -r "$WORK"' EXIT
bash "$REPO/stages/boot/initramfs.sh" "$WORK/first" x64
test "$(cat "$WORK/first/startup.files")" = init
test "$(cat "$WORK/first/exitrd.files")" = shutdown
cmp /input/mica-runkit "$WORK/first/init"
test "$WORK/first/exitrd/shutdown" -ef "$WORK/first/init"
test "$(readlink "$WORK/first/sbin/mica-shutdown")" = /exitrd/shutdown
test "$(find "$WORK/first" -type f | wc -l)" = 5
# One executable's bytes in the archive: its two names are one newc hard link.
test "$(cpio -itv --quiet < /output/initramfs.cpio | awk '$NF == "init" || $NF == "exitrd/shutdown" {print $2}' | sort -u)" = 2
test "$(stat -c%s /output/initramfs.cpio)" -lt "$(( $(stat -c%s /input/mica-runkit) * 2 ))"
for path in bin/busybox sbin/blkid sbin/veritysetup sbin/dmsetup lib usr/lib; do test ! -e "$WORK/first/$path"; done
cp /output/initramfs.cpio "$WORK/first.cpio"
mv /output/initramfs.cpio.zst "$WORK/first.zst"
bash "$REPO/stages/boot/initramfs.sh" "$WORK/repeat" x64
cmp "$WORK/first.cpio" /output/initramfs.cpio
cmp "$WORK/first.zst" /output/initramfs.cpio.zst
printf 'STARTUP_SINGLE_STATIC_MANIFEST_PASS\n'
