#!/usr/bin/env bash
# Run inside the lab image with the evidence directory mounted at /w.
# mica-build-side: container -- QEMU and enrollment tools run in the acceptance lab image.
set -euo pipefail
cd /w
DISK=${1:-image/disk.img}
MODE=${2:-writable}
LIMIT=${3:-100}
ARCH=${4:?amd64 or arm64 required}
case "$ARCH" in
    amd64) QEMU=qemu-system-x86_64; MACHINE=q35; CODE=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd; VARS=/usr/share/OVMF/OVMF_VARS_4M.fd ;;
    arm64) QEMU=qemu-system-aarch64; MACHINE=virt; CODE=/usr/share/AAVMF/AAVMF_CODE.secboot.fd; VARS=/usr/share/AAVMF/AAVMF_VARS.fd ;;
    *) echo 'unsupported acceptance architecture' >&2; exit 1 ;;
esac
DRIVE="if=none,id=disk0,format=raw,file=$DISK"
if [ "$MODE" = readonly ]; then DRIVE="$DRIVE,readonly=on"; fi
if [ ! -f vars.fd ]; then
    cp "$VARS" vars.template.fd
    virt-fw-vars --input vars.template.fd --output vars.fd \
        --set-pk 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem \
        --add-kek 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem \
        --add-db 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem --no-microsoft --sb
fi
IMPORT=()
if [ -d /w/offline ]; then
    IMPORT=(-fsdev local,id=import,path=/w/offline,security_model=none,readonly=on
        -device virtio-9p-pci,fsdev=import,mount_tag=mica-update)
fi
timeout "${LIMIT}s" "$QEMU" -machine "$MACHINE" -cpu max -m 1024 -smp 2 \
    "${IMPORT[@]}" \
    -nographic -no-reboot -device i6300esb -watchdog-action reset \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
    -drive if=pflash,format=raw,unit=0,readonly=on,file="$CODE" \
    -drive if=pflash,format=raw,unit=1,file=vars.fd \
    -drive "$DRIVE" \
    -device virtio-blk-pci,drive=disk0,bootindex=0
