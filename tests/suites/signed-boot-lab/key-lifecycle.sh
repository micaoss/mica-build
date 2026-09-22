#!/usr/bin/env bash
# Probe expiry and built-in key revocation using an existing P1 uefi-x64 initramfs.
# Usage: key-lifecycle.sh KERNEL INITRAMFS CONTENT_CERTIFICATE
# The initramfs must contain the matching signed payload and init-matrix.sh.
# Run under tmux; outputs are isolated and the input archive is never changed.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
[ "$#" -eq 3 ] || { echo 'usage: key-lifecycle.sh KERNEL INITRAMFS CERTIFICATE' >&2; exit 2; }
for input in "$@"; do [ -s "${input}" ] || { echo "missing input: ${input}" >&2; exit 2; }; done
kernel="$(realpath "$1")"; initrd="$(realpath "$2")"; cert="$(realpath "$3")"
image=ai-agent/mica-p2-lab
lab_require_image "${image}"
work="$(mktemp -d "${REPO_ROOT}/_out/p2-lifecycle.XXXXXX")"
printf 'lifecycle outputs: %s\n' "${work}"
cp --reflink=auto "${kernel}" "${work}/kernel"
cp --reflink=auto "${initrd}" "${work}/initramfs.cpio"
cp "${cert}" "${work}/certificate.pem"
cp "${LAB_DIR}/init-lifecycle.sh" "${work}/init-lifecycle"
compiler="$(bash "${REPO_ROOT}/tools/from.sh" --ref mica-build-env:c)"
# mica-build-side: container-block -- compilation and cpio packing run in pinned images.
docker run --rm --label ai-agent=true --network traefik \
    -v "${LAB_DIR}/key-revoke.c:/probe.c:ro" -v "${work}:/w" \
    --entrypoint /bin/sh "${compiler}" -ec \
    'gcc -static -O2 -Wall -Wextra -Werror /probe.c -o /w/key-revoke'
docker run --rm --label ai-agent=true --network traefik -v "${work}:/w" \
    --entrypoint /bin/sh "${image}" -ec '
        cd /w
        chmod 0755 init-lifecycle key-revoke
        printf "%s\n" init-lifecycle key-revoke | cpio -o -H newc --quiet >> initramfs.cpio
        openssl x509 -in certificate.pem -noout -dates
        if openssl verify -attime "$(date -u -d 2020-01-01 +%s)" -CAfile certificate.pem certificate.pem > before-validity.log 2>&1; then exit 1; fi
        grep "error 9 at 0 depth" before-validity.log >/dev/null
        if openssl verify -attime "$(date -u -d 2045-01-01 +%s)" -CAfile certificate.pem certificate.pem > after-expiry.log 2>&1; then exit 1; fi
        grep "error 10 at 0 depth" after-expiry.log >/dev/null
    ' | tee "${work}/certificate-dates.log"
# mica-build-side: host
for epoch in 2020-01-01 2045-01-01; do
    docker run --rm --label ai-agent=true --network traefik \
        --name "ai-agent-mica-lifecycle-$$" -v "${work}:/w:ro" \
        --entrypoint /bin/sh "${image}" -ec '
            timeout 300 qemu-system-x86_64 -machine q35 -cpu max -m 3072 -smp 2 \
                -nographic -no-reboot -rtc "base=$1" -kernel /w/kernel -initrd /w/initramfs.cpio \
                -append "console=ttyS0 rdinit=/init-lifecycle dm_verity.require_signatures=1 panic=10"
        ' -- "${epoch}" 2>&1 | tr -d '\r' > "${work}/${epoch}.log"
    grep -F "LIFECYCLE date=${epoch}" "${work}/${epoch}.log" >/dev/null
    grep -F 'LIFECYCLE revoke-probe=complete' "${work}/${epoch}.log" >/dev/null
    grep -E 'LIFECYCLE revoke .* result=-1 errno=(1|13)$' "${work}/${epoch}.log" >/dev/null
    grep -F 'PROOF valid-signature ACCEPTED (expected)' "${work}/${epoch}.log" >/dev/null
    grep -F 'PROOF unrelated-key REJECTED' "${work}/${epoch}.log" >/dev/null
    grep -F 'PROOF no-signature REJECTED' "${work}/${epoch}.log" >/dev/null
    grep -F 'PROOF END' "${work}/${epoch}.log" >/dev/null
    grep -E '^LIFECYCLE|^PROOF (valid-signature ACCEPTED|no-signature|unrelated-key)' "${work}/${epoch}.log"
done
echo "PASS: certificate dates and runtime revocation measured; logs: ${work}"
