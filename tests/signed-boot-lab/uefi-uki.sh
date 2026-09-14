#!/usr/bin/env bash
# ENTRY SCRIPT -- proof 5 of the plan's P1 row: two boot entries, one signed
# UKI, and the deployment hint that reaches early init.
#
# WHAT IT PROVES. That systemd-boot can carry two Type #1 entries that
# reference ONE signed UKI stored outside the automatically discovered
# EFI/Linux location, that its native boot counting spends an entry's tries
# (`+3` -> `+2-1` -> `+1-2` -> `+0-3`) and then selects the other entry with
# nothing else changed, that `LoaderEntrySelected` reaches early init with the
# counter suffix normalized out, that under Secure Boot the entry's own
# `options` do NOT reach /proc/cmdline -- so the deployment hint has to be the
# variable and not the command line -- and that a UKI with one bit changed is
# refused by the firmware with `Access denied`.
#
# ON WHICH TARGET. QEMU with development PK/KEK/db enrolled into a disposable
# variable store and Secure Boot on: `virt` + AAVMF for arm64, `q35` + OVMF for
# x64. It is not a claim about any physical machine's firmware, which has its
# own enrolled keys and is the platform owner's.
#
#   bash tests/signed-boot-lab/uefi-uki.sh --arch arm64 \
#       --kernel _out/boards/virt-arm64/kernel/Image
#   bash tests/signed-boot-lab/uefi-uki.sh --arch amd64 \
#       --kernel _out/boards/x64/kernel/bzImage
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
lab_require_image "${LAB_IMAGE}"

ARCH=""; KERNEL=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --arch)   ARCH="${2:?--arch takes amd64 or arm64}"; shift 2 ;;
        --kernel) KERNEL="${2:?--kernel takes a file}"; shift 2 ;;
        *) echo "error: '$1' is not an option this script takes" >&2; exit 2 ;;
    esac
done
case "${ARCH}" in
    amd64) EFIARCH=x64;  STUB=/usr/lib/systemd/boot/efi/linuxx64.efi.stub;  BOOTNAME=BOOTX64.EFI;  QEMU=qemu-system-x86_64 ;;
    arm64) EFIARCH=aa64; STUB=/usr/lib/systemd/boot/efi/linuxaa64.efi.stub; BOOTNAME=BOOTAA64.EFI; QEMU=qemu-system-aarch64 ;;
    *) echo "error: --arch takes amd64 or arm64" >&2; exit 2 ;;
esac
[ -s "${KERNEL}" ] || { echo "error: ${KERNEL} does not exist; build the board kernel first" >&2; exit 1; }

mkdir -p "${LAB_WORK}"
cp "${KERNEL}" "${LAB_WORK}/uki-kernel"
lab_docker_run "${LAB_IMAGE}" bash /lab/uefi-inner.sh /w/uki-kernel "${EFIARCH}" "${STUB}" "${BOOTNAME}" "${QEMU}"
