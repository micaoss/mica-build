#!/bin/busybox sh
# The P4 guest payload runs only after the production early loader switches root.
set -eu
bb=/bin/busybox
$bb grep -q '"contentVerified":true' /run/mica/boot.json
$bb grep -q '"secureBoot":true' /run/mica/boot.json
release="$($bb uname -r)"
test -f "/usr/lib/modules/$release/modules.dep"
test -f "/usr/lib/modules/$release/modules.builtin"
$bb grep -q ' /usr/lib/modules squashfs ro,' /proc/mounts
$bb grep -q ' /usr/lib/firmware squashfs ro,' /proc/mounts
if $bb touch /var/unlisted 2>/run/negative-write.log; then
    echo 'FAIL: immutable var accepted a write'; exit 1
fi
$bb grep -q 'Read-only file system' /run/negative-write.log
echo "PASS: signed file root, matching support before services, immutable var"
$bb cat /run/mica/boot.json
echo
echo 'FILE_AB_BOOT_PASS'
$bb sync
$bb poweroff -f
