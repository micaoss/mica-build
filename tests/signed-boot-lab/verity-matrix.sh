#!/usr/bin/env bash
# ENTRY SCRIPT -- proofs 1, 2 and 3 of the file-based A/B plan's P1 row, on one
# kernel.
#
# WHAT IT PROVES. That the kernel under test authenticates a dm-verity root
# hash before it maps a root: a valid detached PKCS#7 signature is accepted and
# the root mounts; an absent one, one by a key the kernel does not trust, one
# with a byte changed, one cut short, and a valid signature over a DIFFERENT
# root's hash are each refused, with the kernel's own errno as the verdict; a
# block modified under an otherwise valid signature is served as EIO while its
# neighbours still read; and the same kernel accepts a SECOND signed root,
# which is the property that decouples rootfs releases from kernel rebuilds.
# Every mapping is created through `veritysetup --root-hash-signature` over a
# read-only loop device with explicit geometry, which is proof 3.
#
# ON WHICH TARGET. Whichever kernel is named: the uefi-x64 or uefi-arm64 mainline
# build, or the cx3576 vendor build. It boots that kernel in QEMU with the two
# roots inside an initramfs, so it needs no disk, no board and no bootloader.
#
#   A_SRC=_out/uefi-x64 B_SRC=_out/second-root \
#     bash tests/signed-boot-lab/verity-matrix.sh \
#       --arch amd64 --kernel _out/boards/uefi-x64/kernel/bzImage
#
# Options: --arch amd64|arm64, --kernel <file>, --append "<extra cmdline>",
# --tag <prefix for the log names>. The cx3576 kernel needs
# `--append initcall_blacklist=rockchip_drm_init`; see the README.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

ARCH=""; KERNEL=""; APPEND=""; TAG=matrix
while [ "$#" -gt 0 ]; do
    case "$1" in
        --arch)   ARCH="${2:?--arch takes amd64 or arm64}"; shift 2 ;;
        --kernel) KERNEL="${2:?--kernel takes a file}"; shift 2 ;;
        --append) APPEND="${2:?--append takes a command line}"; shift 2 ;;
        --tag)    TAG="${2:?--tag takes a name}"; shift 2 ;;
        *) echo "error: '$1' is not an option this script takes" >&2; exit 2 ;;
    esac
done
[ -n "${ARCH}" ] && [ -n "${KERNEL}" ] || { echo "error: --arch and --kernel are both required" >&2; exit 2; }
[ -s "${KERNEL}" ] || { echo "error: ${KERNEL} does not exist; build it first (make uefi-x64-kernel, make uefi-arm64-kernel, make cx3576-kernel)" >&2; exit 2; }

mkdir -p "${LAB_WORK}"
bash "${LAB_DIR}/prepare-payload.sh"
cp "${KERNEL}" "${LAB_WORK}/kernel-${TAG}"

if [ "${ARCH}" = amd64 ]; then
    bash "${LAB_DIR}/build-initramfs.sh" "initramfs-${TAG}.cpio"
else
    bash "${LAB_DIR}/build-initramfs-arm64.sh" "initramfs-${TAG}.cpio"
fi

# Boot 1: the policy ON. Every case's expected verdict is in the guest script.
lab_note "boot 1/4: the matrix under dm_verity.require_signatures=1"
bash "${LAB_DIR}/run-qemu.sh" "${ARCH}" "kernel-${TAG}" "initramfs-${TAG}.cpio" \
    "rdinit=/init dm_verity.require_signatures=1 panic=10 ${APPEND}" "${TAG}-req1.log" 300 >/dev/null

# Boot 2: the policy OFF, which is the plan's point that the SYMBOL is
# capability and the boot parameter is policy. The unsigned case is expected to
# be ACCEPTED here; a run where it is refused would mean the parameter is not
# what decides.
lab_note "boot 2/4: the same matrix under dm_verity.require_signatures=0"
bash "${LAB_DIR}/run-qemu.sh" "${ARCH}" "kernel-${TAG}" "initramfs-${TAG}.cpio" \
    "rdinit=/init dm_verity.require_signatures=0 panic=10 ${APPEND}" "${TAG}-req0.log" 300 >/dev/null

# Boots 3 and 4: the same kernel switches its root onto each signed image in
# turn and runs a program out of it.
for which in a b; do
    lab_note "boot ${which}: switch_root onto signed root ${which}"
    bash "${LAB_DIR}/run-qemu.sh" "${ARCH}" "kernel-${TAG}" "initramfs-${TAG}.cpio" \
        "rdinit=/init mica.mode=switchroot mica.testroot=${which} dm_verity.require_signatures=1 panic=10 ${APPEND}" \
        "${TAG}-switchroot-${which}.log" 300 >/dev/null
done

echo
lab_note "verdicts:"
grep -h '^PROOF' "${LAB_WORK}/${TAG}-req1.log" | sed 's/^/  req1 /'
grep -h '^PROOF policy\|^PROOF no-signature' "${LAB_WORK}/${TAG}-req0.log" | sed 's/^/  req0 /'
for which in a b; do
    grep -h '^PROOF switchroot' "${LAB_WORK}/${TAG}-switchroot-${which}.log" | sed "s/^/  root-${which} /"
done
