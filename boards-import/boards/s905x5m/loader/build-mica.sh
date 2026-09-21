#!/usr/bin/env bash
# mica-build-side: container -- build and verify the required signed FIT firmware.
set -euo pipefail
export PATH="$(tr '\n' ':' < /toolchain-paths)$PATH"
cd /uboot
for patch_file in /patches/*.patch; do
    git apply --check "$patch_file"
    git apply "$patch_file"
done
make -C bl33/v2023 CROSS_COMPILE=aarch64-none-elf- s7d_bm201_config
make -C bl33/v2023 CROSS_COMPILE=aarch64-none-elf- -j8
output=/uboot/bl33/v2023/build
config=$output/.config
for option in MICA_FILE_BOOT ENV_IS_NOWHERE FIT FIT_SIGNATURE RSA RSA_VERIFY SHA256 ZSTD \
    CMD_BOOTM FS_EXT4 EFI_PARTITION WDT WATCHDOG WDT_MESON VIDEO USB_KEYBOARD; do
    grep -qx "CONFIG_$option=y" "$config" || { echo "error: missing $option" >&2; exit 1; }
done
for option in ENV_IS_IN_MMC ENV_IS_IN_STORAGE CMD_SAVEENV CMD_IMPORTENV CMD_SOURCE \
    CMD_CFGLOAD CMD_BOOTI LEGACY_IMAGE_FORMAT USE_PREBOOT BOOTCOUNT_LIMIT AML_FACTORY_BURN_LOCAL_UPGRADE; do
    if grep -qx "CONFIG_$option=y" "$config"; then echo "error: forbidden $option" >&2; exit 1; fi
done
grep -qx 'CONFIG_BOOTCOMMAND="micaboot"' "$config"
bash /bsp/embed-fit-trust.sh "$output/dts/dt.dtb" /mica-boot-trust.crt /uboot/mica-control.dtb "$output/tools"
# OF_EMBED links the compiled tree into BL33. Recompile the full expanded DTS
# so the key passes through the same compiler, linker and FIP packer as the code.
dtc -I dtb -O dts /uboot/mica-control.dtb -o bl33/v2023/arch/arm/dts/amlogic/meson-s7d-bm201.dts
./mk s7d_bm201
dtc -s -I dtb -O dtb /uboot/mica-control.dtb -o /uboot/expected.dtb
dtc -s -I dtb -O dtb "$output/dts/dt.dtb" -o /uboot/actual.dtb
cmp /uboot/expected.dtb /uboot/actual.dtb
mkdir -p /artifact/tools
cp build/u-boot.bin.signed build/u-boot.bin.sd.bin.signed /artifact/
cp /DDR.USB /artifact/
cp "$config" /artifact/config
cp "$output/dts/dt.dtb" /artifact/u-boot.dtb
cp "$output"/tools/{mkimage,dumpimage,fdt_add_pubkey,fit_check_sign} /artifact/tools/
python3 - <<'PY'
from pathlib import Path
import struct
import subprocess

output = Path('/uboot/bl33/v2023/build')
control = (output / 'dts/dt.dtb').read_bytes()
bl33 = (output / 'u-boot.bin').read_bytes()
assert control in bl33, 'required public control FDT is absent from BL33'
for name in ('u-boot.bin.signed', 'u-boot.bin.sd.bin.signed'):
    payload = (Path('/artifact') / name).read_bytes()
    assert 1703936 < len(payload) <= 4193792, 'invalid hardware boot payload capacity'
    offset = payload.find(b'ZSTD', 1703936)
    assert offset >= 1703936, 'compressed BL33 is absent from FIP'
    raw_size, compressed_size = struct.unpack_from('<II', payload, offset + 4)
    compressed = payload[offset + 12:offset + 12 + compressed_size]
    assert len(compressed) == compressed_size
    raw = subprocess.run(['zstd', '-d', '-c'], input=compressed, capture_output=True, check=True).stdout
    assert len(raw) == raw_size and bl33 in raw, 'exported FIP does not contain the rebuilt BL33'
    print(f'FIP_REQUIRED_TRUST_PASS: {name}; BL33={raw_size}; compressed={compressed_size}')
PY
printf '%s\n' 'S905X5M_SIGNED_FIT_FIRMWARE_BUILD_PASS'
