#!/usr/bin/env bash
# Initialize or validate development signing inputs without rotating identities.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
output="$repo/meta"
if [ "$#" -ne 0 ]; then
    [ "$#" -eq 2 ] && [ "$1" = --out ] || {
        echo 'usage: init-keys.sh [--out DIRECTORY]' >&2; exit 2;
    }
    output=$2
fi
for tool in docker realpath flock sha256sum; do command -v "$tool" >/dev/null; done
output=$(realpath -ms "$output")
parent=$output
while [ "$parent" != / ]; do
    [ ! -L "$parent" ] || { echo 'error: signing path contains a symlink' >&2; exit 1; }
    parent=$(dirname "$parent")
done
image=$(bash "${repo}/bin/bun.sh" src/cli.ts from --ref mica-build-env:base)
umask 077
mkdir -p "$repo/.tmp"
lock=$(printf '%s' "$output" | sha256sum | cut -d' ' -f1)
exec 9>"$repo/.tmp/key-init-$lock.lock"
flock -x 9
if [ -d "$output" ] && [ -z "$(find "$output" -mindepth 1 -maxdepth 1 -print -quit)" ]; then
    rmdir "$output"
fi
if [ ! -e "$output" ]; then
    bash "$here/dev-keys.sh" --out "$output"
fi
[ -d "$output" ] && [ ! -L "$output" ] || { echo 'error: invalid signing directory' >&2; exit 1; }
case "$output" in
/work/*) host_output="/srv/station/work/${output#/work/}";;
/root/*) host_output="/srv/station/root/${output#/root/}";;
*) host_output=$output;;
esac
# mica-build-side: container-block -- validate keys with the pinned signing toolchain.
if ! docker run --rm --label ai-agent=true --name "ai-agent-mica-key-init-$$" --network traefik \
    --mount "type=bind,source=$host_output,target=/keys,readonly" \
    --entrypoint /bin/bash "$image" -ceu '
    set -o pipefail
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
'; then
    echo 'error: signing inputs are incomplete, invalid or mismatched; existing identities were not replaced' >&2
    exit 1
fi
# mica-build-side: host
echo "Development signing inputs verified at $output"
