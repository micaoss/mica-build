#!/usr/bin/env bash
# Authenticode signing is repeatable: stages/boot/kernel.sh signs the systemd-boot loader twice with a throwaway
# key to the same bytes, and the signature validates against its certificate and not against another.
#
#   bash tests/gates/boot-signing-test.sh      (make os-boot-test; after make os-boot-tools)
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
IMAGE=ai-agent/mica-boot-tools-amd64
docker image inspect "${IMAGE}" >/dev/null 2>&1 || { echo "error: ${IMAGE} is not built; run make os-boot-tools" >&2; exit 1; }
WORK="$(mktemp -d "${REPO_ROOT}/_out/.boot-signing-test.XXXXXX")"
trap 'docker run --rm --label ai-agent=true --network none -v "${WORK}:/w" --entrypoint rm "${IMAGE}" -rf /w/one /w/two /w/other >/dev/null 2>&1 || true; rm -rf "${WORK}"' EXIT
PASS_N=0; FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

# Throwaway RSA keys, made where openssl is: the build-env base image.
mkdir -p "${WORK}/keys" "${WORK}/other-keys" "${WORK}/one" "${WORK}/two" "${WORK}/other"
# mica-build-side: container-block -- openssl runs in mica-build-env:base.
docker run --rm --label ai-agent=true --network none -v "${WORK}:/w" "$(bash tools/from.sh --ref mica-build-env:base)" bash -c '
    set -euo pipefail
    for d in keys other-keys; do
        openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj "/CN=signing-test-$d" -keyout "/w/$d/key.pem" -out "/w/$d/cert.pem" >/dev/null 2>&1
    done
    chmod 0644 /w/*/key.pem'
# mica-build-side: host
sign() { # <keys dir> <output dir>
    docker run --rm --label ai-agent=true --network none --platform linux/amd64 \
        -v "${WORK}/$1/key.pem:/signing/key.pem:ro" -v "${WORK}/$1/cert.pem:/signing/cert.pem:ro" -v "${WORK}/$2:/output" \
        --entrypoint bash "${IMAGE}" /tools/kernel.sh firmware x64 >/dev/null
}
sign keys one
sleep 2
sign keys two
if cmp -s "${WORK}/one/BOOTX64.EFI" "${WORK}/two/BOOTX64.EFI"; then
    pass "the loader signed twice, two seconds apart, is byte-identical ($(sha256sum "${WORK}/one/BOOTX64.EFI" | cut -c1-16))"
else
    fail "the loader signed twice differs in $(cmp -l "${WORK}/one/BOOTX64.EFI" "${WORK}/two/BOOTX64.EFI" | wc -l) byte(s)"
fi
verify() { # <keys dir>
    docker run --rm --label ai-agent=true --network none --platform linux/amd64 -v "${WORK}:/w:ro" \
        --entrypoint sbverify "${IMAGE}" --cert "/w/$1/cert.pem" /w/one/BOOTX64.EFI >/dev/null 2>&1
}
if verify keys; then pass "the signature validates against its certificate"; else fail "sbverify refused the signature against its own certificate"; fi
if verify other-keys; then fail "sbverify accepted the signature against another certificate"; else pass "the signature is refused against another certificate"; fi
sign other-keys other
if cmp -s "${WORK}/one/BOOTX64.EFI" "${WORK}/other/BOOTX64.EFI"; then fail "another key signed to the same bytes"; else pass "another key signs to other bytes, so the comparison above can fail"; fi

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
