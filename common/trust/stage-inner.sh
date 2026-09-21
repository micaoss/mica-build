#!/usr/bin/env bash
# container -- runs only in the mica-build-env base image, from stage.sh.
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
' "${certificate}" || { echo 'trust-stage: input must contain public certificates only' >&2; exit 1; }
openssl crl2pkcs7 -nocrl -certfile "${certificate}" -outform DER |
    openssl pkcs7 -inform DER -print_certs -noout >/dev/null

sha256sum "${certificate}" | cut -d ' ' -f 1 > /output/sha256
chmod 0644 /output/signer.cert.pem /output/sha256
