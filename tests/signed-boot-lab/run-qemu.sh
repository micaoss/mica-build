#!/usr/bin/env bash
# Boot a kernel with an initramfs under QEMU and capture the console.
#
#   bash tests/signed-boot-lab/run-qemu.sh <amd64|arm64> <kernel> <initramfs> <append> <log> [seconds]
#
# The kernel and the initramfs are named relative to the work directory, which
# is the only thing the container sees. SYSTEM emulation, not binfmt:
# qemu-system-aarch64 is an amd64 binary emulating an aarch64 MACHINE, so the
# host needs no registered interpreter and no arm64 container ever runs.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
lab_require_image "${LAB_IMAGE}"
[ "$#" -ge 5 ] || { echo "usage: run-qemu.sh <amd64|arm64> <kernel> <initramfs> <append> <log> [seconds]" >&2; exit 2; }
ARCH="$1"; KERNEL="$2"; INITRD="$3"; APPEND="$4"; LOG="$5"; SECS="${6:-300}"
case "${ARCH}" in
    amd64) BIN=qemu-system-x86_64; MACHINE=q35;  CONSOLE=ttyS0 ;;
    arm64) BIN=qemu-system-aarch64; MACHINE=virt; CONSOLE=ttyAMA0 ;;
    *) echo "error: '${ARCH}' is neither amd64 nor arm64" >&2; exit 2 ;;
esac
lab_docker_run "${LAB_IMAGE}" bash -c "timeout ${SECS} ${BIN} \
    -machine ${MACHINE} -cpu max -m 3072 -smp 2 -nographic -no-reboot \
    -kernel /w/${KERNEL} -initrd /w/${INITRD} \
    -append \"console=${CONSOLE} ${APPEND}\" 2>&1" | tee "${LAB_WORK}/${LOG}"
lab_note "captured ${LAB_WORK}/${LOG} ($(wc -l < "${LAB_WORK}/${LOG}") lines)"
