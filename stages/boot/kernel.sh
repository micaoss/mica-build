#!/bin/bash
# mica-build-side: container -- package an already built kernel and early init.
set -euo pipefail
export SOURCE_DATE_EPOCH=1577836800
# Authenticode signing records the signing time; sbsign reads the clock, not SOURCE_DATE_EPOCH, so it signs
# under a clock frozen at that instant and signing the same bytes twice gives the same bytes.
SIGNING_CLOCK="$(date -u -d "@${SOURCE_DATE_EPOCH}" '+%Y-%m-%d %H:%M:%S')"
signing_clock() { faketime -f "${SIGNING_CLOCK}" "$@"; }
EFI_ARCH=${2:?EFI architecture required}
case "$EFI_ARCH" in
    x64) STUB=/usr/lib/systemd/boot/efi/linuxx64.efi.stub; BOOT_NAME=BOOTX64.EFI; OBJCOPY=objcopy ;;
    aa64) STUB=/arm64/usr/lib/systemd/boot/efi/linuxaa64.efi.stub; BOOT_NAME=BOOTAA64.EFI; OBJCOPY=aarch64-linux-gnu-objcopy ;;
    *) echo 'error: unsupported EFI architecture' >&2; exit 1 ;;
esac
case "$1" in
kernel)
    bash /tools/initramfs.sh /tmp/initramfs "$EFI_ARCH"
    signing_clock ukify build --linux=/input/kernel --initrd=/output/initramfs.cpio.zst \
        --cmdline=@/input/cmdline --uname="$(cat /input/kernel.release)" \
        --stub="$STUB" --efi-arch="$EFI_ARCH" \
        --os-release=@/input/os-release --output=/output/boot.efi \
        --signtool=sbsign --secureboot-private-key=/signing/key.pem --secureboot-certificate=/signing/cert.pem
    sbverify --cert /signing/cert.pem /output/boot.efi
    "$OBJCOPY" --dump-section .initrd=/output/signed-initrd.zst --dump-section .cmdline=/output/signed-cmdline /output/boot.efi /output/section-copy.efi
    cmp /output/initramfs.cpio.zst /output/signed-initrd.zst
    # The signed command line is the one handed in, with exactly one profile token.
    cmp /input/cmdline /output/signed-cmdline
    test "$(tr ' ' '\n' </output/signed-cmdline | grep -c '^mica\.profile=')" = 1
    tr ' ' '\n' </output/signed-cmdline | grep -Ex 'mica\.profile=(dev|prod)' >/dev/null
    rm /output/signed-initrd.zst /output/signed-cmdline /output/section-copy.efi
    # objcopy must never rewrite the signed PE while extracting a section.
    sbverify --cert /signing/cert.pem /output/boot.efi
    ;;
firmware)
    signing_clock sbsign --key /signing/key.pem --cert /signing/cert.pem --output "/output/$BOOT_NAME" \
        "/usr/lib/systemd/boot/efi/systemd-boot$EFI_ARCH.efi"
    sbverify --cert /signing/cert.pem "/output/$BOOT_NAME"
    ;;
*) echo 'error: expected kernel or firmware' >&2; exit 1 ;;
esac
