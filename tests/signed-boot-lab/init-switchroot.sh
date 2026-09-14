#!/bin/sh
# mica-build-side: container -- PID 1 of the proof initramfs; every command below runs inside the QEMU guest the lab boots.
# PID 1: establish the SIGNED verity mapping named by mica.testroot= and switch
# the machine's root onto it. The point is the switch: a program that runs after
# it is executed out of the authenticated image, not out of this initramfs.
set -u
mount -t proc  proc  /proc  2>/dev/null
mount -t sysfs sysfs /sys   2>/dev/null
mount -t devtmpfs dev /dev  2>/dev/null
mkdir -p /newroot /run

say() { echo "PROOF $*"; }

WHICH=a
for arg in $(cat /proc/cmdline); do
    case "${arg}" in mica.testroot=*) WHICH="${arg#mica.testroot=}" ;; esac
done
say "switchroot target=${WHICH}"

if [ "${WHICH}" = a ]; then
    . /payload/a.env
    IMG=/payload/a.img; SIG=/payload/a.roothash.p7s; HASH="$(cat /payload/a.roothash)"
else
    . /payload/b.env
    IMG=/payload/b.img; SIG=/payload/b.roothash.p7s; HASH="$(cat /payload/b.roothash)"
fi

LOOP="$(losetup --read-only --find --show "${IMG}")"
if ! veritysetup open "${LOOP}" vroot "${LOOP}" "${HASH}" \
        --no-superblock --hash="${VERITY_HASH_ALGO}" \
        --data-block-size="${VERITY_DATA_BLOCK_SIZE}" \
        --hash-block-size="${VERITY_HASH_BLOCK_SIZE}" \
        --data-blocks="${VERITY_DATA_BLOCKS}" \
        --hash-offset="${SQUASHFS_BYTES}" \
        --salt="${VERITY_SALT}" \
        --root-hash-signature="${SIG}"; then
    say "switchroot REFUSED the signed mapping for ${WHICH}"
    while :; do sleep 60; done
fi
say "switchroot mapping created for ${WHICH} hash=${HASH}"

mount -t squashfs -o ro /dev/mapper/vroot /newroot || {
    say "switchroot MOUNT FAILED"; while :; do sleep 60; done; }

# The command that proves it: it is /bin/sh FROM the mounted image, and it reads
# the identity and the mount source it is running on.
exec switch_root /newroot /bin/sh -c '
    /bin/echo "PROOF switchroot RUNNING-FROM-NEW-ROOT $(/bin/cat /etc/hostname 2>/dev/null)"
    /bin/echo "PROOF switchroot os-release $(/bin/sed -n "s/^PRETTY_NAME=//p" /etc/os-release)"
    /bin/echo "PROOF switchroot mica-release $(/bin/cat /etc/mica-release 2>/dev/null | /usr/bin/tr "\n" " ")"
    /bin/echo "PROOF switchroot root-mount $(/bin/grep " / " /proc/mounts)"
    /bin/echo "PROOF switchroot binary $(/bin/ls -l /bin/sh)"
    /bin/echo "PROOF END"
    /bin/sync
    /bin/echo 1 > /proc/sys/kernel/sysrq
    /bin/echo o > /proc/sysrq-trigger
    while : ; do /bin/sleep 60; done'
