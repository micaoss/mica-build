#!/usr/bin/env bash
set -euo pipefail

# Pack the independent bootloader and verify every unpacked input.
work_dir=${1:?usage: pack-and-verify.sh WORK_DIR OUTPUT_DIR}
output_dir=${2:?usage: pack-and-verify.sh WORK_DIR OUTPUT_DIR}
expected_files=(
    DDR.USB
    _aml_dtb.PARTITION
    aml_sdc_burn.UBOOT
    aml_sdc_burn.ini
    bootloader.PARTITION
    platform.conf
    usb_flow.aml
)

[ -d "${work_dir}" ] || { printf 'error: missing work directory: %s\n' "${work_dir}" >&2; exit 1; }
mkdir -p "${output_dir}"
cd "${work_dir}"

sha256sum -c SHA256SUMS

mapfile -t listed_files < <(
    sed -n 's/^[[:space:]]*file="\([^"]*\)".*/\1/p' image.cfg | LC_ALL=C sort -u
)
[ "${#listed_files[@]}" -eq "${#expected_files[@]}" ] || {
    printf 'error: bootloader package manifest names %s files; expected %s\n' \
        "${#listed_files[@]}" "${#expected_files[@]}" >&2
    exit 1
}
for index in "${!expected_files[@]}"; do
    [ "${listed_files[${index}]}" = "${expected_files[${index}]}" ] || {
        printf 'error: manifest file %s is %s; expected %s\n' \
            "${index}" "${listed_files[${index}]}" "${expected_files[${index}]}" >&2
        exit 1
    }
    [ -f "${expected_files[${index}]}" ] || {
        printf 'error: image.cfg names missing input %s\n' "${expected_files[${index}]}" >&2
        exit 1
    }
done

[ -s bootloader.PARTITION ]
[ -s aml_sdc_burn.UBOOT ]
[ -s DDR.USB ]
bl33_nonzero="$(dd if=bootloader.PARTITION bs=4096 skip=416 count=224 status=none \
    | od -An -v -tu1 -w1 | grep -cvx ' *0')"
[ "${bl33_nonzero}" -gt 65536 ] || {
    printf 'error: bootloader.PARTITION has %s non-zero BL33 bytes\n' "${bl33_nonzero}" >&2
    exit 1
}
printf 'ok: bootloader carries %s non-zero BL33 bytes\n' "${bl33_nonzero}"

aml_image_v2_packer -r image.cfg . "${output_dir}/update.img"
test -s "${output_dir}/update.img"
aml_image_v2_packer -c "${output_dir}/update.img"
printf 'ok: Amlogic v2 package format check passed\n'

check_dir="${output_dir}/check"
mkdir -p "${check_dir}"
aml_image_v2_packer -d "${output_dir}/update.img" "${check_dir}" >/dev/null
checked=0
for file in "${expected_files[@]}"; do
    [ -f "${check_dir}/${file}" ] || {
        printf 'error: %s did not survive unpack\n' "${file}" >&2
        exit 1
    }
    cmp -s "${file}" "${check_dir}/${file}" || {
        printf 'error: %s changed during package round trip\n' "${file}" >&2
        exit 1
    }
    checked=$((checked + 1))
done
[ "${checked}" -eq "${#expected_files[@]}" ]
printf 'ok: Amlogic package round-trips %s/%s required inputs unchanged\n' "${checked}" "${#expected_files[@]}"
