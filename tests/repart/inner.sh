#!/bin/bash
# mica-build-side: container -- use the packaged policy on a privileged offline loop disk.
set -euo pipefail
cd /w
unsquashfs -no-progress -d root /rootfs.img etc/repart.d usr/lib/mica/mica-grow-data >/dev/null
cp -a root/etc/repart.d /etc/repart.d
mkdir -p /mnt/system
loop=$(losetup -f)
[ -b "$loop" ] || mknod "$loop" b 7 "${loop#/dev/loop}"
losetup --partscan "$loop" disk.img
cleanup() {
    if mountpoint -q /mnt/system; then umount /mnt/system; fi
    losetup -d "$loop"
}
trap cleanup EXIT
for number in 1 2 3; do
    node="${loop##*/}p$number"
    IFS=: read -r major minor < "/sys/class/block/$node/dev"
    [ -b "/dev/$node" ] || mknod "/dev/$node" b "$major" "$minor"
done
[ "$(blkid -s PARTUUID -o value "${loop}p2")" = "$SYSTEM_UUID" ]
[ "$(blkid -p -s PTUUID -o value "$loop")" = "$DISK_UUID" ]
e2fsck -fn "${loop}p2" > system-fsck.log 2>&1
mount -t ext4 -o ro,noload "${loop}p2" /mnt/system
# Both authentication failures must precede any partition mutation.
dd if=disk.img of=gpt.before bs=512 count=34 status=none
if root/usr/lib/mica/mica-grow-data 00000000-0000-4000-8000-000000000000 "$DISK_UUID" > wrong-system.log 2>&1; then
    echo 'FAIL: wrong SYSTEM identity accepted'; exit 1
fi
if root/usr/lib/mica/mica-grow-data "$SYSTEM_UUID" 00000000-0000-4000-8000-000000000000 > wrong-disk.log 2>&1; then
    echo 'FAIL: wrong disk identity accepted'; exit 1
fi
dd if=disk.img of=gpt.refused bs=512 count=34 status=none
cmp gpt.before gpt.refused
echo 'PASS: growth refuses wrong SYSTEM and disk identities without changing GPT'
python3 /harness/measure.py disk.img before.json
SYSTEMD_LOG_LEVEL=debug timeout -k 5 60 root/usr/lib/mica/mica-grow-data "$SYSTEM_UUID" "$DISK_UUID" > repart.log 2>&1
sync
python3 /harness/measure.py disk.img after.json before.json
sgdisk -v disk.img
systemd-repart --version | head -1
echo 'FILE_DATA_GROWTH_PASS'
