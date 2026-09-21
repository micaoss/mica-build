#!/usr/bin/env bash
# common/trust/stage.sh: a public certificate bundle is validated in
# the pinned OpenSSL image and staged as <parent>/<sha256>/{signer.cert.pem,sha256},
# the trust context a kernel or U-Boot build takes; anything that is not public
# certificates only is refused and nothing is staged.
#
#   bash tests/trust-stage-test.sh          (docker; the image tools/from.sh names for the mica-build-env base image)
#
# The certificates and the one private key (for the refusal) are throwaway
# fixtures made here with the host's openssl in scratch under _out/.
set -euo pipefail
cd "$(dirname "$0")/.."
for t in docker openssl sha256sum; do
    command -v "${t}" >/dev/null 2>&1 || { echo "error: ${t} is required" >&2; exit 1; }
done
STAGE=common/trust/stage.sh
mkdir -p _out
WORK="$(mktemp -d "$(pwd)/_out/trust-stage-test.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
PASS_N=0; FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

for n in a b; do
    openssl req -x509 -newkey rsa:2048 -nodes -keyout "${WORK}/${n}.key" -out "${WORK}/${n}.pem" \
        -days 1 -subj "/CN=trust-stage-test-${n}" >/dev/null 2>&1
done
cat "${WORK}/a.pem" "${WORK}/b.pem" >"${WORK}/bundle.pem"
cat "${WORK}/a.pem" "${WORK}/a.key" >"${WORK}/with-key.pem"
{ cat "${WORK}/a.pem"; echo "trailing text"; } >"${WORK}/trailing.pem"
printf -- '-----BEGIN CERTIFICATE-----\nnotacertificate\n-----END CERTIFICATE-----\n' >"${WORK}/garbage.pem"
: >"${WORK}/empty.pem"

# staged <input> <parent>: the context is <parent>/<sha256 of input> with exactly the two files.
staged() {
    local out="$1" input="$2" parent="$3" sha
    sha="$(sha256sum "${input}" | cut -d' ' -f1)"
    [ "${out}" = "$(realpath "${parent}")/${sha}" ] &&
        cmp -s "${out}/signer.cert.pem" "${input}" &&
        [ "$(cat "${out}/sha256")" = "${sha}" ] &&
        [ "$(find "${out}" -mindepth 1 | wc -l)" -eq 2 ]
}
# refused <name> <input> <message>: non-zero, the message, and the parent holds nothing.
refused() {
    local name="$1" input="$2" want="$3" parent="${WORK}/ctx-$1" left
    if bash "${STAGE}" "${input}" "${parent}" >"${WORK}/$1.out" 2>&1; then
        fail "${name}: staged"
    elif ! grep -c -- "${want}" "${WORK}/$1.out" >/dev/null; then
        fail "${name}: refused without '${want}': $(tail -n2 "${WORK}/$1.out")"
    elif [ -n "$(find "${parent}" -mindepth 1 2>/dev/null)" ]; then
        left="$(find "${parent}" -mindepth 1)"
        fail "${name}: refused but left $(printf '%s\n' "${left}" | tr '\n' ' ')"
    else
        pass "${name}: refused, nothing staged"
    fi
}

if out="$(bash "${STAGE}" "${WORK}/a.pem" "${WORK}/ctx")" && staged "${out}" "${WORK}/a.pem" "${WORK}/ctx"; then
    pass "one certificate is staged as <parent>/<sha256>/{signer.cert.pem,sha256}"
else fail "one certificate: ${out:-no output}"; fi
if again="$(bash "${STAGE}" "${WORK}/a.pem" "${WORK}/ctx")" && [ "${again}" = "${out:-}" ] && [ "$(find "${WORK}/ctx" -mindepth 1 -maxdepth 1 | wc -l)" -eq 1 ]; then
    pass "staging the same certificate again reuses its context"
else fail "restaging: ${again:-no output}"; fi
if out="$(bash "${STAGE}" "${WORK}/bundle.pem" "${WORK}/ctx-bundle")" && staged "${out}" "${WORK}/bundle.pem" "${WORK}/ctx-bundle"; then
    pass "a bundle of two certificates is staged"
else fail "bundle: ${out:-no output}"; fi

refused with-key "${WORK}/with-key.pem" "public certificates only"
refused trailing "${WORK}/trailing.pem" "public certificates only"
refused garbage "${WORK}/garbage.pem" "the certificate bundle was refused"
refused empty "${WORK}/empty.pem" "explicit input is missing"
refused missing "${WORK}/nonexistent.pem" "explicit input is missing"

# A context under the certificate's digest that holds other bytes is refused.
sha="$(sha256sum "${WORK}/b.pem" | cut -d' ' -f1)"
mkdir -p "${WORK}/ctx-tampered/${sha}"
cp "${WORK}/a.pem" "${WORK}/ctx-tampered/${sha}/signer.cert.pem"
echo "${sha}" >"${WORK}/ctx-tampered/${sha}/sha256"
if bash "${STAGE}" "${WORK}/b.pem" "${WORK}/ctx-tampered" >"${WORK}/tampered.out" 2>&1; then fail "a tampered existing context was accepted"
elif grep -c "existing trust context differs" "${WORK}/tampered.out" >/dev/null && cmp -s "${WORK}/a.pem" "${WORK}/ctx-tampered/${sha}/signer.cert.pem" && [ "$(find "${WORK}/ctx-tampered" -mindepth 1 | wc -l)" -eq 3 ]; then
    pass "an existing context with other bytes is refused and left as it was"
else fail "tampered context: $(tail -n2 "${WORK}/tampered.out")"; fi

# Staging is the only mode: no signing here, and a wrong argument count is refused.
if bash "${STAGE}" sign "${WORK}/a.pem" "${WORK}/a.key" "${WORK}/a.pem" "${WORK}/sig" >"${WORK}/sign.out" 2>&1; then fail "a sign invocation ran"
elif grep -c "usage: stage.sh CERTIFICATE_BUNDLE CONTEXT_PARENT" "${WORK}/sign.out" >/dev/null && [ ! -e "${WORK}/sig" ]; then pass "a sign invocation is refused with the usage"
else fail "sign invocation: $(tail -n2 "${WORK}/sign.out")"; fi

echo "trust-stage-test: ${PASS_N} passed, ${FAIL_N} failed"
[ "${FAIL_N}" -eq 0 ]
