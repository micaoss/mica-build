#!/usr/bin/env bash
# One boot of a Compute Engine-like machine (gce.sh), inside the lab image with NET_ADMIN and /dev/net/tun and
# the evidence directory at /w:
#
#   gce-boot.sh <disk> <seconds> <name> [cut-repart|cut-resize|cut-late]
#
# q35 with OVMF whose PK, KEK and db are /w/db.cert.pem alone (no Microsoft keys, Secure Boot on: the image's
# own systemd-boot and UKI must be signed by it), the boot disk on NVMe, no i6300ESB, a virtio-rng and a TPM 2.0
# (swtpm, CRB). The NIC is on a bridge whose DHCP (dnsmasq) answers as Compute Engine's does: MTU 1460, the
# router, DNS and NTP at 169.254.169.254, the instance's hostname; the metadata server (gce-metadata.py) answers
# at 169.254.169.254:80 from /w/metadata. The firmware variables and the TPM state persist under /w, as an
# instance's do. Once the guest's console shows a login prompt, /w/<name>.during.sh runs here (the guest is at
# 10.128.0.2) and the guest is powered off when it ends; without one, it is powered off at once. cut-repart pulls
# the power instead the moment systemd-repart has grown the partition, before the filesystem grows; cut-resize the
# moment the console shows the DATA filesystem being resized, on a disk throttled to 4 MB/s so that the resize
# is still running (the event says whether it had finished); cut-late GCE_CUT_DELAY seconds (default 0.7) after
# the resize starts, unthrottled, so that on a large grow part of it is already committed to the journal. Serial
# console: /w/<name>.serial.
# mica-build-side: container -- QEMU, dnsmasq and the metadata server run in the acceptance lab image.
set -euo pipefail
cd /w
disk=${1:?disk}
limit=${2:?seconds}
name=${3:?name}
cut=${4:-}
serial=/w/$name.serial

if [ ! -f vars.fd ]; then
    cp /usr/share/OVMF/OVMF_VARS_4M.fd vars.template.fd
    virt-fw-vars --input vars.template.fd --output vars.fd \
        --set-pk 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem \
        --add-kek 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem \
        --add-db 6b62601e-3448-4418-8923-7c9fa22ab09b db.cert.pem --no-microsoft --sb
fi

ip link add br0 type bridge
ip link set br0 mtu 1460 up
ip addr add 10.128.0.1/20 dev br0
ip addr add 169.254.169.254/32 dev br0
ip tuntap add tap0 mode tap
ip link set tap0 mtu 1460 master br0 up
dnsmasq --interface=br0 --bind-interfaces --listen-address=10.128.0.1,169.254.169.254 --no-resolv --no-hosts \
    --dhcp-range=10.128.0.2,10.128.0.2,255.255.240.0,1h --dhcp-host=52:54:00:6d:69:63,10.128.0.2,"$(cat metadata/instance/hostname)" \
    --dhcp-option=option:router,10.128.0.1 --dhcp-option=option:dns-server,169.254.169.254 \
    --dhcp-option=option:ntp-server,169.254.169.254 --dhcp-option=option:mtu,1460 \
    --dhcp-option=option:domain-name,c.mica-test.internal \
    --address=/metadata.google.internal/169.254.169.254 \
    --dhcp-leasefile=/tmp/dnsmasq.leases --log-dhcp --log-facility="/w/$name.dnsmasq.log"
python3 /harness/gce-metadata.py /w/metadata 169.254.169.254 80 >"/w/$name.metadata.log" 2>&1 &
mkdir -p tpm
swtpm socket --tpm2 --tpmstate dir=/w/tpm --ctrl type=unixio,path=/tmp/swtpm.sock --daemon

rm -f "$serial" monitor.sock
throttle=
[ "$cut" != cut-resize ] || throttle=,throttling.bps-total=4194304
monitor() { printf '%s\n' "$1" | socat - UNIX-CONNECT:/w/monitor.sock >/dev/null 2>&1 || true; }
(
    case "$cut" in
    cut-repart) until grep -qa 'Finished.*systemd-repart' "$serial" 2>/dev/null; do sleep 0.1; done
        monitor quit
        echo "gce-boot: power cut after repart, before growfs" >>"/w/$name.events"
        exit 0 ;;
    cut-resize) until grep -qa 'resizing filesystem' "$serial" 2>/dev/null; do sleep 0.1; done
        monitor quit
        grep -qa 'resized filesystem to' "$serial" && done=finished || done=unfinished
        echo "gce-boot: power cut while DATA is resized (resize $done)" >>"/w/$name.events"
        exit 0 ;;
    cut-late) until grep -qa 'resizing filesystem' "$serial" 2>/dev/null; do sleep 0.05; done
        sleep "${GCE_CUT_DELAY:-0.7}"
        monitor quit
        grep -qa 'resized filesystem to' "$serial" && done=finished || done=unfinished
        echo "gce-boot: power cut ${GCE_CUT_DELAY:-0.7} s into the DATA resize (resize $done)" >>"/w/$name.events"
        exit 0 ;;
    esac
    until grep -qa 'login:' "$serial" 2>/dev/null; do sleep 1; done
    echo "gce-boot: login prompt" >>"/w/$name.events"
    if [ -f "/w/$name.during.sh" ]; then
        bash "/w/$name.during.sh" >"/w/$name.during.log" 2>&1 && echo "gce-boot: during PASS" >>"/w/$name.events" ||
            echo "gce-boot: during FAIL ($?)" >>"/w/$name.events"
    fi
    monitor system_powerdown
) &
watcher=$!

status=0
timeout "${limit}s" qemu-system-x86_64 -machine q35 -cpu max -m 2048 -smp 2 \
    -nographic -no-reboot \
    -monitor unix:/w/monitor.sock,server=on,wait=off \
    -drive if=pflash,format=raw,unit=0,readonly=on,file=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd \
    -drive if=pflash,format=raw,unit=1,file=vars.fd \
    -drive "if=none,id=disk0,format=raw,file=$disk${throttle:-}" \
    -device nvme,drive=disk0,serial=persistent-disk-0,bootindex=0 \
    -netdev tap,id=net0,ifname=tap0,script=no,downscript=no -device virtio-net-pci,netdev=net0,mac=52:54:00:6d:69:63 \
    -object rng-random,id=rng0,filename=/dev/urandom -device virtio-rng-pci,rng=rng0 \
    -chardev socket,id=chrtpm,path=/tmp/swtpm.sock -tpmdev emulator,id=tpm0,chardev=chrtpm -device tpm-crb,tpmdev=tpm0 \
    </dev/null >"$serial" 2>&1 || status=$?
kill "$watcher" 2>/dev/null || true
echo "gce-boot: qemu exit $status" >>"/w/$name.events"
exit 0
