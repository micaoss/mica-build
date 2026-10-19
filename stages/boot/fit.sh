#!/bin/bash
# mica-build-side: container -- sign the complete kernel/DTB/initramfs configuration. On a board whose boot trust
# is none (/input/boot-trust) the configuration carries no signature node: its images carry their sha256 hashes,
# which the loader verifies, and nothing proves who made them.
set -euo pipefail
export SOURCE_DATE_EPOCH=1577836800
# The FIT `arch` of the board's kernel (src/image/backends/uboot-fit.ts): arm64 boots an Image, compressed here;
# arm boots a zImage, which decompresses itself.
read -r fit_arch < /input/fit-arch
case "$fit_arch" in
    arm64) closure=aa64 kernel_payload=kernel.zst kernel_compression=zstd ;;
    arm) closure=arm kernel_payload=kernel kernel_compression=none ;;
    *) echo "error: /input/fit-arch names '$fit_arch', neither arm64 nor arm" >&2; exit 1 ;;
esac
read -r trust < /input/boot-trust
case "$trust" in
    fit) signature='signature { algo = "sha256,rsa2048"; key-name-hint = "mica"; sign-images = "kernel", "fdt", "ramdisk"; };' ;;
    none) signature='' ;;
    *) echo "error: /input/boot-trust names '$trust', neither fit nor none" >&2; exit 1 ;;
esac
bash /tools/initramfs.sh /tmp/initramfs "$closure"
test "$(stat -c%s /input/kernel)" -le 134217728
test "$(stat -c%s /output/initramfs.cpio)" -le 67108864
test "$(stat -c%s /output/initramfs.cpio.zst)" -le 67108864
source /tools/compression.sh
if [ "$kernel_compression" = zstd ]; then compress_payload /input/kernel /output/kernel.zst 134217728; else cp /input/kernel /output/kernel; fi
mkdir -p /tmp/fit-keys
ln -s /signing/key.pem /tmp/fit-keys/mica.key
ln -s /signing/cert.pem /tmp/fit-keys/mica.crt
cd /output
read -r kernel_address fdt_address ramdisk_address < /input/fit-addresses
for address in "$kernel_address" "$fdt_address" "$ramdisk_address"; do
    [[ "$address" =~ ^0x[0-9a-f]{8}$ ]]
done
cat > boot.its <<ITS
/dts-v1/;
/ {
    description = "Mica OS authenticated kernel package";
    #address-cells = <1>;
    images {
        kernel { description = "Mica OS Linux kernel"; data = /incbin/("$kernel_payload"); type = "kernel"; arch = "$fit_arch"; os = "linux"; compression = "$kernel_compression";
            load = <$kernel_address>; entry = <$kernel_address>; hash { algo = "sha256"; }; };
        fdt { description = "Mica OS board device tree"; data = /incbin/("/input/board.dtb"); type = "flat_dt"; arch = "$fit_arch"; compression = "none";
            load = <$fdt_address>; hash { algo = "sha256"; }; };
        ramdisk { description = "Mica OS authenticated boot and shutdown environment"; data = /incbin/("initramfs.cpio.zst"); type = "ramdisk"; arch = "$fit_arch"; os = "linux"; compression = "none";
            load = <$ramdisk_address>; hash { algo = "sha256"; }; };
    };
    configurations {
        default = "conf";
        conf { description = "Mica OS signed boot"; kernel = "kernel"; fdt = "fdt"; ramdisk = "ramdisk";
            $signature };
    };
};
ITS
if [ "$trust" = fit ]; then
    mkimage -f boot.its -k /tmp/fit-keys -r boot.itb
    printf '/dts-v1/; / {};' | dtc -I dts -O dtb -o control.dtb
    fdt_add_pubkey -a sha256,rsa2048 -k /tmp/fit-keys -n mica -r conf control.dtb
    fit_check_sign -f boot.itb -k control.dtb
else
    mkimage -f boot.its boot.itb
    [ -z "$(fdtget -l boot.itb /configurations/conf)" ] || { echo 'error: an unsigned FIT carries a configuration subnode' >&2; exit 1; }
    # fdtget prints a byte string as unpadded hexadecimal bytes.
    for image in kernel:"$kernel_payload" fdt:/input/board.dtb ramdisk:initramfs.cpio.zst; do
        test "$(fdtget -t s boot.itb "/images/${image%%:*}/hash" algo)" = sha256
        value=''
        for byte in $(fdtget -t bx boot.itb "/images/${image%%:*}/hash" value); do value+=$(printf '%02x' "0x$byte"); done
        test "$value" = "$(sha256sum "${image#*:}" | cut -d' ' -f1)"
    done
fi
# Check the bytes actually covered by the signature, including pass-through
# ramdisk semantics. FDT stays uncompressed.
test "$(fdtget -t s boot.itb /images/ramdisk compression)" = none
test "$(fdtget -t s boot.itb /images/fdt compression)" = none
test "$(fdtget -t s boot.itb /images/kernel compression)" = "$kernel_compression"
dumpimage -T flat_dt -p 0 -o signed-kernel boot.itb
cmp "$kernel_payload" signed-kernel
if [ "$kernel_compression" = zstd ]; then validate_payload signed-kernel /input/kernel 134217728; fi
rm signed-kernel
dumpimage -T flat_dt -p 2 -o signed-initrd.zst boot.itb
cmp initramfs.cpio.zst signed-initrd.zst
rm signed-initrd.zst
test "$(stat -c%s boot.itb)" -le 134217728
printf '%s\n' 'MICA_SIGNED_FIT_KERNEL_PASS'
