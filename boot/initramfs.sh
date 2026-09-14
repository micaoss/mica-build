#!/bin/bash
# mica-build-side: container -- assemble static startup and retained shutdown from one mica-runkit.
set -euo pipefail
DEST="$1"
EFI_ARCH=${2:?EFI architecture required}
mkdir -p "$DEST"/{sbin,dev,proc,sys,run,system,support,newroot,etc/mica}
# Preserve the existing architecture/ELF validation. Any discovered interpreter
# or library violates the one-file startup contract.
python3 /tools/elf-closure.py / "$DEST" "$EFI_ARCH" /input/mica-runkit /init
find "$DEST" -type f -printf '%P\n' | LC_ALL=C sort > /output/startup.files
test "$(cat /output/startup.files)" = init
test -x "$DEST/init"
install -m 0644 /output/startup.files "$DEST/startup.files"
install -m 0644 /input/boot.json "$DEST/etc/mica/boot.json"
# mica-runkit selects its entry point by the name it is invoked as. The retained
# shutdown is a hard link to /init: the cpio stores the bytes once, /init stays
# the regular file PID 1 is executed from, and copy_exitrd still retains a
# regular /shutdown.
mkdir -p "$DEST/exitrd"
ln "$DEST/init" "$DEST/exitrd/shutdown"
find "$DEST/exitrd" -type f -printf '%P\n' | LC_ALL=C sort > "$DEST/exitrd.files"
test "$(cat "$DEST/exitrd.files")" = shutdown
test "$DEST/exitrd/shutdown" -ef "$DEST/init"
# Startup observation reaches the same executable as mica-shutdown.
ln -s /exitrd/shutdown "$DEST/sbin/mica-shutdown"
find "$DEST" -type f -printf '%P\n' | LC_ALL=C sort > /output/initramfs.files
printf '%s\n' etc/mica/boot.json exitrd.files exitrd/shutdown init startup.files > /output/expected.files
cmp /output/expected.files /output/initramfs.files
rm /output/expected.files
(
    cd "$DEST"
    find . -exec touch -h -d @1577836800 {} +
    find . -print0 | LC_ALL=C sort -z | cpio --null --reproducible --owner=0:0 -o -H newc --quiet
) > /output/initramfs.cpio
source /tools/compression.sh
# Expanded cpio AND transported bytes retain the existing 64 MiB safety bound.
# Compression saves artifact bytes, not boot RAM.
compress_payload /output/initramfs.cpio /output/initramfs.cpio.zst 67108864
stat -c '%n %s' /output/initramfs.cpio /output/initramfs.cpio.zst > /output/initramfs.sizes
sha256sum /output/initramfs.cpio /output/initramfs.cpio.zst > /output/initramfs.sha256
