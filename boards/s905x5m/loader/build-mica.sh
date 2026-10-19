#!/usr/bin/env bash
# mica-build-side: container -- build and verify the required signed FIT firmware.
set -euo pipefail

verify_control_fdt_address() {
    local source="$1"

    if grep -qF 'env_set_hex("dtb_mem_addr"' "$source"; then
        echo 'error: dtb_mem_addr must include a 0x prefix for base-zero consumers' >&2
        return 1
    fi
    grep -qF '"0x%lx"' "$source" || {
        echo 'error: dtb_mem_addr is not formatted as an explicitly prefixed hexadecimal address' >&2
        return 1
    }
    grep -qF 'env_set("dtb_mem_addr", dtb_mem_addr)' "$source" || {
        echo 'error: the prefixed control FDT address is not installed in the environment' >&2
        return 1
    }
}

verify_gpio_upgrade_config() {
    local config="$1"
    local option

    grep -qx 'CONFIG_ENABLE_AML_GPIO_UPGRADE=y' "$config" || {
        echo 'error: the BM201 GPIO upgrade path must be enabled' >&2
        return 1
    }
    grep -qx 'CONFIG_AML_GPIO_UPGRADE_KEY="GPIOD_2"' "$config" || {
        echo 'error: the BM201 GPIO upgrade key must be GPIOD_2' >&2
        return 1
    }
    grep -qx 'CONFIG_USB_TOOL_ENTRY="adnl 0"' "$config" || {
        echo 'error: explicit BM201 USB recovery must wait without an enumeration timeout' >&2
        return 1
    }
    for option in AML_NO_USB_MODULE ADNL_FORCE_BL1_IF_SCS; do
        if grep -qx "CONFIG_$option=y" "$config"; then
            echo "error: USB entry must not enable automatic erasure via $option" >&2
            return 1
        fi
    done
}

verify_usb_recovery_path() {
    local source="$1"
    local recovery_line
    local control_fdt_line

    grep -qF 'if (run_command("gpio input " CONFIG_AML_GPIO_UPGRADE_KEY, 0))' "$source" || {
        echo 'error: the BM201 recovery key is not sampled with vendor GPIO semantics' >&2
        return 1
    }
    grep -qF 'run_command("run usb_burning", 0)' "$source" || {
        echo 'error: the BM201 recovery key does not dispatch USB burning' >&2
        return 1
    }
    recovery_line="$(awk 'index($0, "bm201_check_usb_recovery_key();") { print NR; exit }' "$source")"
    control_fdt_line="$(awk 'index($0, "run_command(\"fdt addr ${dtb_mem_addr}\", 0);") { print NR; exit }' "$source")"
    [ -n "$recovery_line" ] && [ -n "$control_fdt_line" ] &&
        [ "$recovery_line" -lt "$control_fdt_line" ] || {
        echo 'error: USB recovery must run before control-FDT setup' >&2
        return 1
    }
    grep -qF 'env_set("preboot", NULL);' "$source" || {
        echo 'error: vendor preboot must remain disabled' >&2
        return 1
    }
}

if [ "${1:-}" = --verify-control-fdt-address ]; then
    [ "$#" -eq 2 ] || {
        echo 'usage: build-mica.sh --verify-control-fdt-address <board-source>' >&2
        exit 64
    }
    verify_control_fdt_address "$2"
    exit 0
fi
if [ "${1:-}" = --verify-gpio-upgrade-config ]; then
    [ "$#" -eq 2 ] || {
        echo 'usage: build-mica.sh --verify-gpio-upgrade-config <config>' >&2
        exit 64
    }
    verify_gpio_upgrade_config "$2"
    exit 0
fi
if [ "${1:-}" = --verify-usb-recovery-path ]; then
    [ "$#" -eq 2 ] || {
        echo 'usage: build-mica.sh --verify-usb-recovery-path <board-source>' >&2
        exit 64
    }
    verify_usb_recovery_path "$2"
    exit 0
fi

export PATH="$(tr '\n' ':' < /toolchain-paths)$PATH"
cd /uboot
for patch_file in /patches/*.patch; do
    git apply --check "$patch_file"
    git apply "$patch_file"
done
verify_control_fdt_address bl33/v2023/board/amlogic/s7d_bm201/s7d_bm201.c
verify_usb_recovery_path bl33/v2023/board/amlogic/s7d_bm201/s7d_bm201.c
verify_gpio_upgrade_config bl33/v2023/configs/amlogic/s7d_bm201_defconfig
python3 /bsp/tests/signed-fit-test.py /uboot/bl33/v2023 \
    --config bl33/v2023/configs/amlogic/s7d_bm201_defconfig
python3 /bsp/tests/usb-recovery-test.py /uboot/bl33/v2023 \
    --config bl33/v2023/configs/amlogic/s7d_bm201_defconfig
python3 /bsp/tests/handoff-test.py /uboot/bl33/v2023 --sanitize
python3 /bsp/tests/dual-media-test.py /uboot/bl33/v2023/common/mica-file-boot.c --common /uboot/bl33/v2023/common
python3 /bsp/tests/build-jobs-test.py /uboot/fip/build_bl33.sh
make -C bl33/v2023 CROSS_COMPILE=aarch64-none-elf- s7d_bm201_config
make -C bl33/v2023 CROSS_COMPILE=aarch64-none-elf- -j2
output=/uboot/bl33/v2023/build
config=$output/.config
verify_gpio_upgrade_config "$config"
for option in MICA_FILE_BOOT ENV_IS_NOWHERE FIT FIT_SIGNATURE RSA RSA_VERIFY SHA256 ZSTD \
    CMD_BOOTM FS_EXT4 EFI_PARTITION WDT WATCHDOG WDT_MESON VIDEO USB_KEYBOARD; do
    grep -qx "CONFIG_$option=y" "$config" || { echo "error: missing $option" >&2; exit 1; }
done
for option in ENV_IS_IN_MMC ENV_IS_IN_STORAGE CMD_SAVEENV CMD_IMPORTENV CMD_SOURCE \
    CMD_CFGLOAD CMD_BOOTI LEGACY_IMAGE_FORMAT USE_PREBOOT BOOTCOUNT_LIMIT AML_FACTORY_BURN_LOCAL_UPGRADE \
    AMLOGIC_AMFC; do
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
