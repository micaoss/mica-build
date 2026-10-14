#!/bin/bash
# mica-build-side: container -- sign the complete kernel/DTB/initramfs configuration.
set -euo pipefail
export SOURCE_DATE_EPOCH=1577836800
bash /tools/initramfs.sh /tmp/initramfs aa64
test "$(stat -c%s /input/kernel)" -le 134217728
test "$(stat -c%s /output/initramfs.cpio)" -le 67108864
test "$(stat -c%s /output/initramfs.cpio.zst)" -le 67108864
source /tools/compression.sh
compress_payload /input/kernel /output/kernel.zst 134217728
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
        kernel { description = "Mica OS Linux kernel"; data = /incbin/("kernel.zst"); type = "kernel"; arch = "arm64"; os = "linux"; compression = "zstd";
            load = <$kernel_address>; entry = <$kernel_address>; hash { algo = "sha256"; }; };
        fdt { description = "Mica OS board device tree"; data = /incbin/("/input/board.dtb"); type = "flat_dt"; arch = "arm64"; compression = "none";
            load = <$fdt_address>; hash { algo = "sha256"; }; };
        ramdisk { description = "Mica OS authenticated boot and shutdown environment"; data = /incbin/("initramfs.cpio.zst"); type = "ramdisk"; arch = "arm64"; os = "linux"; compression = "none";
            load = <$ramdisk_address>; hash { algo = "sha256"; }; };
    };
    configurations {
        default = "conf";
        conf { description = "Mica OS signed boot"; kernel = "kernel"; fdt = "fdt"; ramdisk = "ramdisk";
            signature { algo = "sha256,rsa2048"; key-name-hint = "mica"; sign-images = "kernel", "fdt", "ramdisk"; }; };
    };
};
ITS
mkimage -f boot.its -k /tmp/fit-keys -r boot.itb
printf '/dts-v1/; / {};' | dtc -I dts -O dtb -o control.dtb
fdt_add_pubkey -a sha256,rsa2048 -k /tmp/fit-keys -n mica -r conf control.dtb
fit_check_sign -f boot.itb -k control.dtb
# Check the bytes actually covered by the signature, including pass-through
# ramdisk semantics. FDT stays uncompressed.
test "$(fdtget -t s boot.itb /images/ramdisk compression)" = none
test "$(fdtget -t s boot.itb /images/fdt compression)" = none
test "$(fdtget -t s boot.itb /images/kernel compression)" = zstd
dumpimage -T flat_dt -p 0 -o signed-kernel.zst boot.itb
cmp kernel.zst signed-kernel.zst
validate_payload signed-kernel.zst /input/kernel 134217728
rm signed-kernel.zst
dumpimage -T flat_dt -p 2 -o signed-initrd.zst boot.itb
cmp initramfs.cpio.zst signed-initrd.zst
rm signed-initrd.zst
test "$(stat -c%s boot.itb)" -le 134217728
printf '%s\n' 'MICA_SIGNED_FIT_KERNEL_PASS'
