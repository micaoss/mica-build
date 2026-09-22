#!/usr/bin/env bash
# mica-build-side: container -- runs only in the pinned OpenSSL build image.
set -euo pipefail
umask 0077
cp /certificate.pem /output/signer.cert.pem
certificate=/output/signer.cert.pem

# Permit only a nonempty PEM certificate bundle; private keys and trailing data
# must never enter a public build context even if OpenSSL would ignore them.
awk '
    /^-----BEGIN CERTIFICATE-----$/ { if (inside) exit 1; inside=1; count++; next }
    /^-----END CERTIFICATE-----$/ { if (!inside) exit 1; inside=0; next }
    inside && /^[A-Za-z0-9+\/=]+$/ { next }
    !inside && /^[[:space:]]*$/ { next }
    { bad=1; exit 1 }
    END { if (inside || !count || bad) exit 1 }
' "${certificate}" || { echo 'verity-tool: input must contain public certificates only' >&2; exit 1; }
openssl crl2pkcs7 -nocrl -certfile "${certificate}" -outform DER |
    openssl pkcs7 -inform DER -print_certs -noout >/dev/null

[ "${1:-}" = sign ] || { echo 'verity-tool: the only mode is sign' >&2; exit 1; }
[ "$(stat -c%s /roothash)" -eq 64 ] && LC_ALL=C grep -Eq '^[0-9a-f]{64}$' /roothash || {
    echo 'verity-tool: root hash must be exactly 64 lowercase ASCII hex bytes' >&2; exit 1;
}
[ "$(grep -c '^-----BEGIN CERTIFICATE-----$' "${certificate}")" -eq 1 ] || {
    echo 'verity-tool: signing requires exactly one certificate' >&2; exit 1;
}
openssl x509 -in "${certificate}" -pubkey -noout |
    openssl pkey -pubin -text -noout |
    grep -E '^Public-Key: \(2048 bit\)$' >/dev/null || {
        echo 'verity-tool: signing requires RSA-2048' >&2; exit 1;
    }
openssl smime -sign -binary -noattr -nocerts -md sha256 \
    -in /roothash -inkey /private.pem -signer "${certificate}" \
    -outform DER -out /output/signature
openssl cms -verify -binary -inform DER -in /output/signature \
    -content /roothash -certfile "${certificate}" -noverify -out /dev/null 2>/dev/null
chmod 0644 /output/signature
