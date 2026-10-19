#!/usr/bin/env bash
# mica-build-side: container -- runs only in the mica-build-env base image, from src/boot/dev-keys.ts:
# the three development signing identities into /keys, one per trust domain.
set -euo pipefail
umask 077
mkdir /keys/boot /keys/verity /keys/updates
for domain in boot verity; do
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
        -subj "/CN=MICA-development-$domain" \
        -keyout "/keys/$domain/signer.key.pem" -out "/keys/$domain/signer.cert.pem" 2>/dev/null
done
openssl genpkey -algorithm ED25519 -out /keys/updates/signer.key.pem
openssl pkey -in /keys/updates/signer.key.pem -pubout -outform DER | tail -c 32 | base64 -w0 > /keys/updates/public.key
printf "DEVELOPMENT-GRADE\nDOMAINS=boot verity updates\n" > /keys/GENERATED
chmod 0644 /keys/boot/*.cert.pem /keys/verity/*.cert.pem /keys/updates/public.key /keys/GENERATED
