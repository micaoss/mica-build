#!/usr/bin/env bash
# mica-build-side: container -- runs only in the pinned OpenSSL build image, from src/image/module-signing.ts:
# a detached signature beside every module under /modules (<module>.p7s), each verified against the
# certificate. PKCS#1 v1.5 over SHA-256 with no signed attributes and no certificates, the form the kernel's
# module loader reads: deterministic, so the same module and key give the same bytes.
set -euo pipefail
umask 0022
certificate=/certificate.pem
[ "$(grep -c '^-----BEGIN CERTIFICATE-----$' "${certificate}")" -eq 1 ] || {
    echo 'module-sign: signing requires exactly one certificate' >&2; exit 1;
}
openssl x509 -in "${certificate}" -pubkey -noout | openssl pkey -pubin -outform DER > /tmp/cert.pub
openssl pkey -in /private.pem -pubout -outform DER > /tmp/key.pub
cmp -s /tmp/cert.pub /tmp/key.pub || { echo 'module-sign: the key is not the certificate'"'"'s' >&2; exit 1; }
n=0
while IFS= read -r -d '' module; do
    openssl smime -sign -binary -noattr -nocerts -md sha256 \
        -in "${module}" -inkey /private.pem -signer "${certificate}" \
        -outform DER -out "${module}.p7s"
    openssl cms -verify -binary -inform DER -in "${module}.p7s" \
        -content "${module}" -certfile "${certificate}" -noverify -out /dev/null 2>/dev/null
    n=$((n + 1))
done < <(find /modules -type f -name '*.ko' -print0 | sort -z)
echo "module-sign: ${n} module(s) signed"
