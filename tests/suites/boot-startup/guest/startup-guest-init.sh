#!/bin/busybox sh
# PID1 in a disposable x64 guest. Reference tools are test-only payloads.
set -eu
BB=/bin/busybox
fail() { echo "BOOT_STARTUP_GUEST_FAIL $*"; "$BB" poweroff -f; }
trap 'fail unexpected-command-failure' EXIT
# mica-runkit is reached by the name init; /init itself is this script.
worker() { /runkit/init --startup-worker "$1"; }
transition() {
    # Exercise the startup syscalls with no external mount/losetup/switch_root.
    "$BB" mkdir -p /newroot
    worker '{"Mount":{"source":"tmpfs","target":"/newroot","kind":"tmpfs","options":"nosuid,nodev,mode=0755,size=16777216"}}'
    "$BB" mkdir -p /newroot/sbin /newroot/dev /newroot/proc /newroot/sys /newroot/run /newroot/source /newroot/bound
    "$BB" cp /fixture /newroot/sbin/init
    echo retained > /run/transition-marker
    echo reclaim > /old-root-file
    echo bound > /newroot/source/file
    worker '{"Bind":{"source":"/newroot/source","target":"/newroot/bound"}}'
    worker '{"Remount":{"target":"/newroot/bound","options":"remount,bind,ro,nodev,nosuid"}}'
    if (echo forbidden > /newroot/bound/file); then fail writable-bind; fi
    test "$("$BB" cat /newroot/bound/file)" = bound
    worker '{"Move":{"source":"/dev","target":"/newroot/dev"}}'
    worker '{"Move":{"source":"/proc","target":"/newroot/proc"}}'
    worker '{"Move":{"source":"/sys","target":"/newroot/sys"}}'
    worker '{"Move":{"source":"/run","target":"/newroot/run"}}'
    trap - EXIT
    exec /fixture switch

}
for path in dev proc sys run; do "$BB" mkdir -p "/$path"; done
worker '{"Mount":{"source":"devtmpfs","target":"/dev","kind":"devtmpfs","options":"nosuid,mode=0755"}}'
worker '{"Mount":{"source":"proc","target":"/proc","kind":"proc","options":"nosuid,nodev,noexec"}}'
worker '{"Mount":{"source":"sysfs","target":"/sys","kind":"sysfs","options":"nosuid,nodev,noexec"}}'
worker '{"Mount":{"source":"tmpfs","target":"/run","kind":"tmpfs","options":"nosuid,nodev,mode=0755,size=32M"}}'
mode=$("$BB" cat /case)
if [ "$mode" = transition ]; then transition; fi
if [ "$mode" != unsigned-guard ]; then
    test "$("$BB" cat /sys/module/dm_verity/parameters/require_signatures)" = Y
fi
worker '{"Loop":{"image":"/data/image"}}' > /run/loop-device
device=$("$BB" cat /run/loop-device)
echo "NATIVE_LOOP_IDENTITY_PASS $device"
if [ "$mode" = untrusted ]; then
    if /fixture open "$device" /data/untrusted.p7s /data/untrusted.json > /run/untrusted-refusal 2>&1; then fail untrusted-signature-accepted; fi
    "$BB" cat /run/untrusted-refusal
    # The built-in-keyring verifier returns ENOKEY for an unknown signer.
    "$BB" grep -F 'Required key not available' /run/untrusted-refusal
    test ! -e /dev/mapper/mica-root
    echo 'UNTRUSTED_SIGNATURE_KERNEL_TABLE_REFUSAL_PASS'
    /fixture skip-key "$device" /data/image.json
    "$BB" poweroff -f
fi
if [ "$mode" = unsigned-guard ]; then
    /fixture omit-signature "$device" /data/image.json
    echo 'BOOT_STARTUP_UNSIGNED_GUARD_PASS'
    "$BB" poweroff -f
fi
test "$("$BB" cat /sys/module/dm_verity/parameters/require_signatures)" = Y
root=$("$BB" cat /data/roothash)
salt=$("$BB" cat /data/salt)
/sbin/veritysetup open "$device" mica-root "$device" "$root" --no-superblock --format 1 --hash sha256 --data-block-size 4096 --hash-block-size 4096 --data-blocks 2 --hash-offset 8192 --salt "$salt" --root-hash-signature /data/trusted.p7s --panic-on-corruption
/sbin/dmsetup table mica-root > /run/reference.table
/fixture expected "$device" /data/image.json > /run/expected.table
"$BB" cmp /run/reference.table /run/expected.table
/sbin/veritysetup close mica-root
request="{\"Verity\":{\"device\":\"$device\",\"name\":\"mica-root\",\"signature\":\"/data/trusted.p7s\",\"image\":$("$BB" cat /data/image.json)}}"
worker "$request"
/fixture table > /run/native.table
"$BB" cmp /run/reference.table /run/native.table
/fixture table > /run/readback.table
"$BB" cmp /run/reference.table /run/readback.table
echo 'VERITYSETUP_NATIVE_DIFFERENTIAL_TABLE_PASS'
if [ "$mode" = corrupt-data ]; then
    echo 'CORRUPTED_DATA_MAPPING_LOADED_EXPECT_AUTHENTICATED_READ_PANIC'
    /fixture read
    fail corrupted-data-read-accepted
fi
/fixture read
/sbin/veritysetup close mica-root
refuse_open() {
    label=$1; signature=$2; descriptor=$3
    if /fixture open "$device" "$signature" "$descriptor" > /run/refusal 2>&1; then fail "$label-accepted"; fi
    "$BB" cat /run/refusal
    test ! -e /dev/mapper/mica-root
    echo "VERITY_NEGATIVE_PASS $label"
}
# A post-activation alias failure must remove the owned mapping, preserving
# the existing unrelated filesystem object.
echo occupied > /dev/mapper/mica-root
if /fixture open "$device" /data/trusted.p7s /data/image.json; then fail occupied-alias-accepted; fi
if /sbin/dmsetup info mica-root; then fail partial-activation-leaked; fi
test "$("$BB" cat /dev/mapper/mica-root)" = occupied
"$BB" rm /dev/mapper/mica-root
echo 'PARTIAL_ACTIVATION_ROLLBACK_PASS'
# The kernel itself rejects writable verity. Independently exercise the
# userspace read-only status guard against real writable/read-only zero targets.
/fixture expected "$device" /data/image.json > /run/expected.table
if /sbin/dmsetup create mica-root --table "$("$BB" cat /run/expected.table)"; then fail writable-verity-accepted; fi
/sbin/dmsetup create mica-root --uuid MICA-writable-guard --table '0 8 zero'
/sbin/dmsetup mknodes mica-root
if /fixture status > /run/writable-refusal 2>&1; then fail writable-status-accepted; fi
"$BB" cat /run/writable-refusal
"$BB" grep -F 'Protocol error' /run/writable-refusal
/sbin/dmsetup remove mica-root
"$BB" rm -f /dev/mapper/mica-root
/sbin/dmsetup create mica-root --readonly --uuid MICA-readonly-guard --table '0 8 zero'
/sbin/dmsetup mknodes mica-root
/fixture status
/sbin/dmsetup remove mica-root
"$BB" rm -f /dev/mapper/mica-root
echo 'READONLY_KERNEL_AND_STATUS_GUARD_PASS'
refuse_open missing-signature /data/missing.p7s /data/image.json
refuse_open corrupt-signature-bytes /data/corrupt.p7s /data/image.json
refuse_open corrupt-signature-kernel /data/corrupt.p7s /data/corrupt.json
refuse_open untrusted-signature /data/untrusted.p7s /data/untrusted.json
refuse_open wrong-root /data/trusted.p7s /data/wrong-root.json
/fixture skip-key "$device" /data/image.json
test ! -e /dev/mapper/mica-root
uuid=$("$BB" cat /data/partuuid)
worker "{\"Partition\":{\"uuid\":\"$uuid\"}}" > /run/partition
test "$("$BB" cat /run/partition)" = /dev/vda1
if /fixture partition aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa; then fail non-gpt-accepted; fi
echo 'GPT_ONLY_DEVICE_LOOKUP_PASS'

transition
