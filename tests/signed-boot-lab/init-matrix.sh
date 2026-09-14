#!/bin/sh
# mica-build-side: container -- PID 1 of the proof initramfs; every command below runs inside the QEMU guest the lab boots.
# PID 1 of the verity proof initramfs. Prints one RESULT line per case and
# powers the machine off. Never exits: an exit from PID 1 is a kernel panic,
# which would look like a failed proof rather than a finished one.
set -u

mount -t proc  proc  /proc  2>/dev/null
mount -t sysfs sysfs /sys   2>/dev/null
mount -t devtmpfs dev /dev  2>/dev/null
mkdir -p /dev/pts /run /mnt/a /mnt/b
mount -t devpts devpts /dev/pts 2>/dev/null

say() { echo "PROOF $*"; }

# The policy the kernel is enforcing on this boot, read from the module
# parameter rather than from the command line: a parameter the kernel did not
# accept leaves no trace on /proc/cmdline's copy of it.
POLICY=absent
[ -r /sys/module/dm_verity/parameters/require_signatures ] &&
    POLICY="$(cat /sys/module/dm_verity/parameters/require_signatures)"
say "policy require_signatures=${POLICY}"
say "cmdline $(cat /proc/cmdline)"
say "kernel $(uname -r) $(uname -m)"

. /payload/a.env
A_HASH="$(cat /payload/a.roothash)"
. /payload/b.env.prefixed
B_HASH="$(cat /payload/b.roothash)"

LOOP_A="$(losetup --read-only --find --show /payload/a.img)"
say "loop a ${LOOP_A} $(blockdev --getsize64 "${LOOP_A}") bytes read-only=$(blockdev --getro "${LOOP_A}")"

# Every open below uses the same explicit geometry: no superblock, the hash
# tree in the same file at --hash-offset, and the salt/algorithm/block sizes
# rootfs/scripts/pack-verity.sh recorded. Nothing is discovered from the image.
open_a() {                       # open_a <name> <root-hash> [extra args...]
    name="$1"; hash="$2"; shift 2
    veritysetup open "${LOOP_A}" "${name}" "${LOOP_A}" "${hash}" \
        --no-superblock \
        --hash="${VERITY_HASH_ALGO}" \
        --data-block-size="${VERITY_DATA_BLOCK_SIZE}" \
        --hash-block-size="${VERITY_HASH_BLOCK_SIZE}" \
        --data-blocks="${VERITY_DATA_BLOCKS}" \
        --hash-offset="${SQUASHFS_BYTES}" \
        --salt="${VERITY_SALT}" "$@" 2>&1
}

case_expect_ok() {               # <case> <name> <hash> [args...]
    label="$1"; shift
    out="$(open_a "$@")"; rc=$?
    if [ "${rc}" -eq 0 ]; then say "${label} ACCEPTED (expected)"
    else say "${label} REJECTED rc=${rc} -- ${out}"; fi
    return "${rc}"
}

case_expect_fail() {             # <case> <name> <hash> [args...]
    label="$1"; shift
    out="$(open_a "$@")"; rc=$?
    if [ "${rc}" -eq 0 ]; then
        say "${label} ACCEPTED rc=0 -- THE MAPPING WAS CREATED"
        veritysetup close "$1" 2>/dev/null
    else
        say "${label} REJECTED rc=${rc} -- ${out}"
    fi
}

# --- 1. the valid signature -------------------------------------------------
if case_expect_ok valid-signature va "${A_HASH}" --root-hash-signature=/payload/a.roothash.p7s; then
    mount -t squashfs -o ro /dev/mapper/va /mnt/a &&
        say "valid-signature MOUNTED $(sed -n 's/^PRETTY_NAME=//p' /mnt/a/etc/os-release 2>/dev/null) files=$(ls /mnt/a | tr '\n' ' ')"
    say "valid-signature dm-table $(dmsetup table va 2>/dev/null)"
    umount /mnt/a 2>/dev/null
    veritysetup close va
fi

# --- 2. no signature at all -------------------------------------------------
case_expect_fail no-signature vb "${A_HASH}"

# --- 3. a signature by a key the kernel does not trust -----------------------
case_expect_fail unrelated-key vc "${A_HASH}" --root-hash-signature=/payload/a.roothash.wrongkey.p7s

# --- 4. the trusted signature with one byte changed -------------------------
case_expect_fail modified-signature vd "${A_HASH}" --root-hash-signature=/payload/a.roothash.modified.p7s

# --- 5. the trusted signature, truncated ------------------------------------
case_expect_fail truncated-signature ve "${A_HASH}" --root-hash-signature=/payload/a.roothash.truncated.p7s

# --- 6. a VALID signature over a DIFFERENT root hash ------------------------
# The signature verifies as a signature; it just does not cover this hash.
case_expect_fail signature-of-other-root vf "${A_HASH}" --root-hash-signature=/payload/b.roothash.p7s

# --- 7. the second signed root, same kernel ---------------------------------
LOOP_B="$(losetup --read-only --find --show /payload/b.img)"
if veritysetup open "${LOOP_B}" vg "${LOOP_B}" "${B_HASH}" \
        --no-superblock --hash="${B_VERITY_HASH_ALGO}" \
        --data-block-size="${B_VERITY_DATA_BLOCK_SIZE}" \
        --hash-block-size="${B_VERITY_HASH_BLOCK_SIZE}" \
        --data-blocks="${B_VERITY_DATA_BLOCKS}" \
        --hash-offset="${B_SQUASHFS_BYTES}" \
        --salt="${B_VERITY_SALT}" \
        --root-hash-signature=/payload/b.roothash.p7s 2>&1; then
    say "second-root ACCEPTED (expected) hash=${B_HASH}"
    mount -t squashfs -o ro /dev/mapper/vg /mnt/b &&
        say "second-root MOUNTED $(sed -n 's/^PRETTY_NAME=//p' /mnt/b/etc/os-release 2>/dev/null)"
    umount /mnt/b 2>/dev/null
    veritysetup close vg
else
    say "second-root REJECTED -- the same kernel did not take the other signed root"
fi

# --- 8. a modified data block under a valid signature -----------------------
# The signature covers the root hash, so the MAPPING is created; the corrupted
# block is only discovered when it is read.
cp /payload/a.img /corrupt.img
CORRUPT_BLOCK=$((VERITY_DATA_BLOCKS / 2))
printf 'MICACORRUPT' | dd of=/corrupt.img bs=1 \
    seek=$((CORRUPT_BLOCK * VERITY_DATA_BLOCK_SIZE + 64)) conv=notrunc status=none
LOOP_C="$(losetup --read-only --find --show /corrupt.img)"
if veritysetup open "${LOOP_C}" vh "${LOOP_C}" "${A_HASH}" \
        --no-superblock --hash="${VERITY_HASH_ALGO}" \
        --data-block-size="${VERITY_DATA_BLOCK_SIZE}" \
        --hash-block-size="${VERITY_HASH_BLOCK_SIZE}" \
        --data-blocks="${VERITY_DATA_BLOCKS}" \
        --hash-offset="${SQUASHFS_BYTES}" \
        --salt="${VERITY_SALT}" \
        --root-hash-signature=/payload/a.roothash.p7s 2>&1; then
    say "corrupt-block MAPPED (expected: the signature covers the hash, not the blocks)"
    if dd if=/dev/mapper/vh bs="${VERITY_DATA_BLOCK_SIZE}" skip="${CORRUPT_BLOCK}" count=1 \
            of=/dev/null status=none 2>/tmp/dd.err; then
        say "corrupt-block READ-OK -- the modified block was served"
    else
        say "corrupt-block READ-REFUSED $(tr '\n' ' ' < /tmp/dd.err)"
    fi
    # An untouched block still reads, so the failure above is the block and not
    # the mapping.
    if dd if=/dev/mapper/vh bs="${VERITY_DATA_BLOCK_SIZE}" skip=1 count=1 \
            of=/dev/null status=none 2>/dev/null; then
        say "corrupt-block OTHER-BLOCK-READ-OK"
    else
        say "corrupt-block OTHER-BLOCK-READ-REFUSED"
    fi
    veritysetup close vh 2>/dev/null
else
    say "corrupt-block MAPPING-REFUSED -- unexpected: the root hash is unchanged"
fi

say "dmesg-verity $(dmesg | grep -ci 'verity') lines"
dmesg | grep -i 'verity\|PKCS7\|pkcs7\|asymmetric\|Missing X.509' | sed 's/^/PROOF dmesg: /'
say "END"

sync
echo 1 > /proc/sys/kernel/sysrq 2>/dev/null
echo o > /proc/sysrq-trigger 2>/dev/null
# If sysrq is not built in, hold the machine until the harness times it out
# rather than panicking with an exit from PID 1.
while : ; do sleep 60; done
