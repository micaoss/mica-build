#!/bin/bash
# mica-build-side: container -- actual signed payload bytes; fixture signing only.
set -euo pipefail
mode=${1:?uki or fit}
if [ "$mode" = uki ]; then
    # The boot tools name the EFI architecture as UEFI does, in lower case.
    bash /tools/kernel.sh kernel "$(echo X64 | tr '[:upper:]' '[:lower:]')"
    python3 - /output/boot.efi /output/initramfs.cpio.zst /output/tampered.efi <<'PY'
import pathlib, sys
uki, payload, output = map(pathlib.Path, sys.argv[1:])
b = bytearray(uki.read_bytes()); p = payload.read_bytes()
at = b.find(p); assert at >= 0 and b.find(p, at + 1) == -1
b[at + len(p) - 1] ^= 1; output.write_bytes(b)
PY
    if sbverify --cert /signing/cert.pem /output/tampered.efi; then
        echo 'ERROR: tampered signed UKI ramdisk accepted'; exit 1
    fi
    printf '%s\n' SIGNED_UKI_COMPRESSED_BYTES_PASS
elif [ "$mode" = fit ]; then
    bash /tools/fit.sh
    fit_check_sign -f /output/boot.itb -k /cx-control.dtb
    for payload in kernel.zst initramfs.cpio.zst; do
        python3 - /output/boot.itb "/output/$payload" /output/tampered.itb <<'PY'
import pathlib, sys
fit, payload, output = map(pathlib.Path, sys.argv[1:])
b = bytearray(fit.read_bytes()); p = payload.read_bytes()
at = b.find(p); assert at >= 0 and b.find(p, at + 1) == -1
b[at + len(p) - 1] ^= 1; output.write_bytes(b)
PY
        if fit_check_sign -f /output/tampered.itb -k /output/control.dtb; then
            echo 'ERROR: tampered signed FIT payload accepted'; exit 1
        fi
    done
    printf '%s\n' SIGNED_FIT_COMPRESSED_BYTES_PASS
else
    exit 2
fi
sha256sum /output/initramfs.cpio /output/initramfs.cpio.zst
