#!/bin/bash
# mica-build-side: container -- disposable TCG guest, regular input files only.
set -euo pipefail
mode=${1:?transition, unsigned-guard, signed, or corrupt-data required}
case "$mode" in transition|unsigned-guard|untrusted|signed|corrupt-data) ;; *) exit 2 ;; esac
cd /w
for tool in qemu-system-x86_64 sgdisk timeout; do command -v "$tool" >/dev/null; done
if [ ! -f gpt.img ]; then
    truncate -s 8M gpt.img
    sgdisk --new=1:2048:8191 --partition-guid=1:12345678-1234-4321-abcd-1234567890ab gpt.img > gpt.log
    truncate -s 8M nongpt.img
    # An MBR table cannot become a GPT match through a broader parser fallback.
    printf '\125\252' | dd of=nongpt.img bs=1 seek=510 conv=notrunc status=none
    printf '\203' | dd of=nongpt.img bs=1 seek=450 conv=notrunc status=none
fi
required=1
if [ "$mode" = unsigned-guard ]; then required=0; fi
result=0
timeout -k 10 180 qemu-system-x86_64 -accel tcg -machine q35 -cpu max -smp 2 -m 512 -nographic -no-reboot -nic none \
    -kernel inputs/bzImage -initrd "$mode.cpio.zst" \
    -append "console=ttyS0,115200 rdinit=/init panic=-1 dm_verity.require_signatures=$required" \
    -drive if=none,id=gpt,format=raw,file=gpt.img,readonly=on -device virtio-blk-pci,drive=gpt \
    -drive if=none,id=nongpt,format=raw,file=nongpt.img,readonly=on -device virtio-blk-pci,drive=nongpt \
    > "logs/$mode.console" 2>&1 || result=$?
printf '%s\n' "$result" > "logs/$mode.qemu-exit"
test "$result" = 0
if grep -F 'BOOT_STARTUP_GUEST_FAIL' "logs/$mode.console"; then exit 1; fi
case "$mode" in
    transition)
        grep -F 'mica-init: old root startup files reclaimed' "logs/$mode.console"
        grep -F 'NATIVE_SWITCH_ROOT_API_AND_RECLAMATION_PASS' "logs/$mode.console" ;;
    unsigned-guard)
        grep -F 'SIGNATURE_READBACK_MUTATION_REFUSED' "logs/$mode.console"
        grep -F 'BOOT_STARTUP_UNSIGNED_GUARD_PASS' "logs/$mode.console" ;;
    untrusted)
        grep -F 'Root hash verification failed (-ENOKEY)' "logs/$mode.console"
        grep -F 'UNTRUSTED_SIGNATURE_KERNEL_TABLE_REFUSAL_PASS' "logs/$mode.console"
        grep -F 'KEY_INSERTION_MUTATION_TABLE_REFUSAL' "logs/$mode.console" ;;
    signed)
        grep -F 'PARTIAL_ACTIVATION_ROLLBACK_PASS' "logs/$mode.console"
        grep -F 'READONLY_KERNEL_AND_STATUS_GUARD_PASS' "logs/$mode.console"
        grep -F 'VERITYSETUP_NATIVE_DIFFERENTIAL_TABLE_PASS' "logs/$mode.console"
        for case in missing-signature corrupt-signature-bytes corrupt-signature-kernel untrusted-signature wrong-root; do grep -F "VERITY_NEGATIVE_PASS $case" "logs/$mode.console"; done
        grep -F 'KEY_INSERTION_MUTATION_TABLE_REFUSAL' "logs/$mode.console"
        grep -F 'GPT_ONLY_DEVICE_LOOKUP_PASS' "logs/$mode.console"
        grep -F 'NATIVE_SWITCH_ROOT_API_AND_RECLAMATION_PASS' "logs/$mode.console" ;;
    corrupt-data)
        grep -F 'CORRUPTED_DATA_MAPPING_LOADED_EXPECT_AUTHENTICATED_READ_PANIC' "logs/$mode.console"
        grep -F 'Kernel panic' "logs/$mode.console"
        if grep -F 'AUTHENTICATED_READ_PASS' "logs/$mode.console"; then exit 1; fi ;;
esac
sha256sum "logs/$mode.console" "$mode.cpio.zst" inputs/bzImage
