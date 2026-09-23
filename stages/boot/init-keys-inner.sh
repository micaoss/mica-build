#!/usr/bin/env bash
# mica-build-side: container -- runs only in the mica-build-env base image, from src/boot/init-keys.ts:
# validate the development signing inputs under /keys (read-only) without rotating any identity.
set -euo pipefail
regular() { test -f "$1" && test -s "$1" && test ! -L "$1"; }
regular /keys/GENERATED
grep -qx DEVELOPMENT-GRADE /keys/GENERATED
for domain in boot verity updates; do
    test -d /keys/$domain && test ! -L /keys/$domain
    test "$(stat -c %a /keys/$domain)" = 700
    regular /keys/$domain/signer.key.pem
    test "$(stat -c %a /keys/$domain/signer.key.pem)" = 600
    openssl pkey -in /keys/$domain/signer.key.pem -passin pass: -check -noout >/dev/null 2>&1
    openssl pkey -in /keys/$domain/signer.key.pem -passin pass: -pubout -outform DER > /tmp/$domain.pub
done
for domain in boot verity; do
    regular /keys/$domain/signer.cert.pem
    openssl rsa -in /keys/$domain/signer.key.pem -passin pass: -check -noout >/dev/null 2>&1
    openssl x509 -in /keys/$domain/signer.cert.pem -checkend 0 -noout >/dev/null
    openssl verify -CAfile /keys/$domain/signer.cert.pem /keys/$domain/signer.cert.pem >/dev/null
    openssl x509 -in /keys/$domain/signer.cert.pem -pubkey -noout |
        openssl pkey -pubin -outform DER > /tmp/$domain.cert.pub
    cmp -s /tmp/$domain.pub /tmp/$domain.cert.pub
done
openssl pkey -in /keys/updates/signer.key.pem -passin pass: -text_pub -noout | grep -c "^ED25519 Public-Key:" >/dev/null
regular /keys/updates/public.key
tail -c 32 /tmp/updates.pub | base64 -w0 > /tmp/metadata.base64
cmp -s /tmp/metadata.base64 /keys/updates/public.key
! cmp -s /tmp/boot.pub /tmp/verity.pub
! cmp -s /tmp/boot.pub /tmp/updates.pub
! cmp -s /tmp/verity.pub /tmp/updates.pub
