#!/usr/bin/env bash
# mica-build-side: container -- runs only in the pinned OpenSSL build image, from src/image/module-signing.ts:
# a detached signature beside every module under /modules (<module>.p7s), or the files SIGN_NAME names, each
# verified against the certificate. PKCS#1 v1.5 over SHA-256 with no signed attributes, the form the kernel's module loader reads:
# deterministic, so the same module and key give the same bytes. With MODULE_SIGN_CHAIN=1 the signature carries
# the signer's certificate and /chain.pem's (an owner key under an enrolled CA); otherwise none, the
# certificate being in the kernel's builtin keyring.
set -euo pipefail
umask 0022
certificate=/certificate.pem
[ "$(grep -c '^-----BEGIN CERTIFICATE-----$' "${certificate}")" -eq 1 ] || {
    echo 'module-sign: signing requires exactly one certificate' >&2; exit 1;
}
openssl x509 -in "${certificate}" -pubkey -noout | openssl pkey -pubin -outform DER > /tmp/cert.pub
openssl pkey -in /private.pem -pubout -outform DER > /tmp/key.pub
cmp -s /tmp/cert.pub /tmp/key.pub || { echo 'module-sign: the key is not the certificate'"'"'s' >&2; exit 1; }
certs=(-nocerts)
if [ "${MODULE_SIGN_CHAIN:-0}" = 1 ]; then certs=(); [ ! -s /chain.pem ] || certs=(-certfile /chain.pem); fi
n=0
while IFS= read -r -d '' module; do
    openssl smime -sign -binary -noattr "${certs[@]}" -md sha256 \
        -in "${module}" -inkey /private.pem -signer "${certificate}" \
        -outform DER -out "${module}.p7s"
    openssl cms -verify -binary -inform DER -in "${module}.p7s" \
        -content "${module}" -certfile "${certificate}" -noverify -out /dev/null 2>/dev/null
    n=$((n + 1))
done < <(find /modules -type f -name "${SIGN_NAME:-*.ko}" -print0 | sort -z)
echo "module-sign: ${n} file(s) signed"
