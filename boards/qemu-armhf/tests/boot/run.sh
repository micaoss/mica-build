#!/usr/bin/env bash
# Boot the board's U-Boot and kernel from a UBI flash image under QEMU.
#
#   run.sh <kernel-dir> <u-boot.bin> <work> [tries]
#
# <kernel-dir> holds the kernel artifact's zImage and qemu-virt.dtb, <u-boot.bin> is the loader artifact's, and
# <work> (inside this checkout) is scratch. The initramfs is init.c alone, built static in the bsp image; the FIT
# carries it with the kernel and the device tree, hashed and unsigned, since the board's boot trust is none.
# flash.ts lays the FIT out as the one deployment's kernel object, on trial when [tries] is given.
#
# The boot passes when U-Boot selects the deployment (spending one try when it is on trial), the kernel attaches
# the UBI region named on its built-in command line, init reads the deployment id U-Boot put in /chosen and both
# record copies back, the i6300esb watchdog the kernel arms is registered, and eth0 carries its permanent, globally
# administered address.
set -euo pipefail
[ "$#" -ge 3 ] && [ "$#" -le 4 ] || { echo 'usage: run.sh <kernel-dir> <u-boot.bin> <work> [tries]' >&2; exit 2; }
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "${here}/../../../.." && pwd)"
kernel="$(realpath "$1")"; loader="$(realpath "$2")"; mkdir -p "$3"; work="$(realpath "$3")"; tries="${4-}"
for p in "${kernel}" "${loader}" "${work}"; do
    case "${p}/" in "${repo}"/*) ;; *) echo "error: ${p} is outside ${repo}, the one path the containers mount" >&2; exit 2 ;; esac
done
docker image inspect ai-agent/mica-p2-lab >/dev/null 2>&1 \
    || { echo 'error: ai-agent/mica-p2-lab is not built: bash tests/suites/signed-boot-lab/images.sh --lifecycle' >&2; exit 1; }
mapfile -t BSP < <(bash "${repo}/bin/mica-tools" from MICA_BUILD_BSP=mica-build-env:bsp)
run() {  # run <name> <image> <script>
    docker run --rm --label ai-agent=true --name "ai-agent-qemu-armhf-boot-$1-$$" -v "${repo}:${repo}" -w "${work}" "$2" bash -c "$3"
}

rm -rf "${work}/fit" "${work}/flash" && mkdir -p "${work}/fit/root/proc" "${work}/fit/root/sys" "${work}/fit/root/dev" "${work}/flash"
cp "${kernel}/zImage" "${kernel}/qemu-virt.dtb" "${work}/fit/"
run init "${BSP[1]#*=}" "arm-linux-gnueabihf-gcc -static -Os -Wall -o fit/root/init '${here}/init.c'"
cat > "${work}/fit/boot.its" <<'ITS'
/dts-v1/;
/ {
    description = "qemu-armhf boot test";
    #address-cells = <1>;
    images {
        kernel { data = /incbin/("zImage"); type = "kernel"; arch = "arm"; os = "linux"; compression = "none";
            load = <0x42000000>; entry = <0x42000000>; hash { algo = "sha256"; }; };
        fdt { data = /incbin/("qemu-virt.dtb"); type = "flat_dt"; arch = "arm"; compression = "none";
            load = <0x43000000>; hash { algo = "sha256"; }; };
        ramdisk { data = /incbin/("initramfs.cpio"); type = "ramdisk"; arch = "arm"; os = "linux"; compression = "none";
            load = <0x43100000>; hash { algo = "sha256"; }; };
    };
    configurations {
        default = "conf";
        conf { kernel = "kernel"; fdt = "fdt"; ramdisk = "ramdisk"; };
    };
};
ITS
run fit ai-agent/mica-p2-lab 'set -e; cd fit; (cd root && find . | sort | cpio -o -H newc --reproducible -R 0:0 --quiet) > initramfs.cpio
    SOURCE_DATE_EPOCH=1577836800 mkimage -f boot.its boot.itb >/dev/null'

out="$(bash "${repo}/bin/bun.sh" "${here}/flash.ts" "${here}/../../flash.tsv" "${loader}" "${work}/fit/boot.itb" \
    "${work}/flash" "${work}/flash.img" ${tries:+"${tries}"})"
deployment="$(awk '{print $2}' <<<"${out}")"
dd if="${work}/flash.img" of="${work}/pflash0.img" bs=1M count=64 status=none
dd if="${work}/flash.img" of="${work}/pflash1.img" bs=1M skip=64 status=none
# The NIC carries a globally administered address, as a board's hardware does: QEMU's default 52:54:00:12:34:56 is
# locally administered, which micad's `mac` device code source refuses (mica-core:docs/factory-ap-key.md).
# 00:00:5e:00:53:01 is of the range RFC 7042 sets aside for documentation.
MAC=00:00:5e:00:53:01
timeout -k 5 200 docker run --rm --label ai-agent=true --name "ai-agent-qemu-armhf-boot-qemu-$$" -v "${repo}:${repo}" -w "${work}" \
    ai-agent/mica-p2-lab timeout 180 qemu-system-arm -M virt,highmem=off -cpu cortex-a15 -m 128M -nographic -no-reboot \
    -drive if=pflash,format=raw,file=pflash0.img -drive if=pflash,format=raw,file=pflash1.img -device i6300esb \
    -netdev user,id=net0 -device virtio-net-device,netdev=net0,mac="${MAC}" \
    > "${work}/serial.log" 2>&1 || true

fail=0
expect() {  # expect <what> <fixed string>
    if grep -aqF -- "$2" "${work}/serial.log"; then echo "ok: $1"; else echo "FAIL: $1 (no '$2')"; fail=1; fi
}
if [ -n "${tries}" ]; then
    expect 'U-Boot spends one try' "Mica OS FIT selected: ${deployment}; tries left $((tries - 1))"
    expect 'the spent try is persisted' ",1,$((tries - 1))"
else
    expect 'U-Boot selects the deployment' "Mica OS FIT selected: ${deployment}"
fi
expect 'the kernel starts' 'Starting kernel ...'
expect 'the kernel attaches the ubi region' 'attached mtd2 (name "ubi"'
expect 'init runs' 'MICA_QEMU_ARMHF_INIT'
expect 'the deployment id reaches /chosen' "deployment: ${deployment}"
expect 'both record copies read back' 'records-b: flag'
expect 'the watchdog is registered' 'watchdog: i6300ESB timer'
expect 'eth0 carries the global address' "eth0 address: ${MAC}"
expect 'the address is the permanent one' 'eth0 assign type: 0'
expect 'init finishes' 'MICA_QEMU_ARMHF_INIT_DONE'
[ "${fail}" = 0 ] || { echo "run.sh: failed; the console is ${work}/serial.log" >&2; exit 1; }
echo "run.sh: passed; the console is ${work}/serial.log"
