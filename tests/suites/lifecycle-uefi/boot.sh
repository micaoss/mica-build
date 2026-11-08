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
# An update catalog (core-sets.sh): the guest reaches it at http://10.0.2.2:8000/, QEMU's address for this container.
if [ -d /w/www ]; then
    python3 -m http.server -d /w/www -b 127.0.0.1 8000 >/w/www.log 2>&1 &
fi
# The USB serial adapter (QEMU's usb-serial is an FTDI FT232, 0403:6001) is a device present at boot whose driver,
# ftdi_sio, is a module of the driver classes (common/kernel/fragments/drivers-<arch>.fragment): runtime.sh holds the
# init to loading it. always-plugged: without it QEMU unplugs the adapter of a null chardev and the guest never sees it.
# The hotplug check (runtime.sh) asks on the console for the adapter to be replaced after boot: the monitor unplugs
# it and plugs a new one. A boot that never asks leaves the watcher waiting until QEMU ends.
rm -f serial.log monitor.sock
(
    until grep -qa FILE_AB_HOTPLUG_WANTED serial.log 2>/dev/null; do sleep 1; done
    printf 'device_del ftdi0\n' | socat - UNIX-CONNECT:monitor.sock >/dev/null
    sleep 3
    printf 'chardev-add null,id=ftdihot\ndevice_add usb-serial,bus=usb.0,chardev=ftdihot,always-plugged=on,id=ftdihot\n' |
        socat - UNIX-CONNECT:monitor.sock >/dev/null
) &
watcher=$!
# CONSOLE_ENTER=1: someone at the console presses Enter at each owner certificate the runkit asks to have confirmed
# (mica-core:docs/mica-core.md 6.5). The serial console reads QEMU's stdin, here a FIFO the answerer writes.
answerer=
exec 3</dev/null
if [ "${CONSOLE_ENTER:-}" = 1 ]; then
    mkfifo /tmp/console.in
    exec 3<>/tmp/console.in
    (
        answered=0
        while :; do
            asked=$(grep -ac 'press Enter on this console' serial.log 2>/dev/null || true)
            while [ "${asked:-0}" -gt "$answered" ]; do printf '\r' >&3; answered=$((answered + 1)); done
            sleep 1
        done
    ) &
    answerer=$!
fi
status=0
timeout "${LIMIT}s" "$QEMU" -machine "$MACHINE" -cpu max -m 1024 -smp 2 \
    "${IMPORT[@]}" \
    -nographic -no-reboot -device i6300esb -watchdog-action reset \
    -monitor unix:monitor.sock,server=on,wait=off \
    -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
    -device qemu-xhci,id=usb -chardev null,id=ftdi -device usb-serial,bus=usb.0,chardev=ftdi,always-plugged=on,id=ftdi0 \
    -drive if=pflash,format=raw,unit=0,readonly=on,file="$CODE" \
    -drive if=pflash,format=raw,unit=1,file=vars.fd \
    -drive "$DRIVE" \
    -device virtio-blk-pci,drive=disk0,bootindex=0 <&3 | tee serial.log || status=$?
kill "$watcher" $answerer 2>/dev/null || true
exit "$status"
