#!/usr/bin/env bash
# Generate isolated development inputs; no existing directory is overwritten.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
repo=$(cd "$here/.." && pwd)
[ "$#" -eq 2 ] && [ "$1" = --out ] || { echo 'usage: dev-keys.sh --out NEW_DIRECTORY' >&2; exit 2; }
command -v docker >/dev/null
command -v realpath >/dev/null
output=$(realpath -m "$2")
[ ! -e "$output" ] && [ ! -L "$output" ] || { echo 'error: key output already exists' >&2; exit 1; }
mkdir -p "$(dirname "$output")"
umask 077
mkdir "$output"
case "$output" in
/work/*) host_output="/srv/station/work/${output#/work/}";;
/root/*) host_output="/srv/station/root/${output#/root/}";;
*) host_output=$output;;
esac
image=$(bash "$repo/tools/from.sh" --ref IMAGE_MICA_BUILD_BASE)
# mica-build-side: container-block -- key generation uses the pinned OpenSSL image.
docker run --rm --label ai-agent=true --network traefik \
    --user "$(id -u):$(id -g)" -v "$host_output:/keys" --entrypoint /bin/bash "$image" -ceu '
    set -o pipefail
    umask 077
    mkdir /keys/boot /keys/verity /keys/updates
    for domain in boot verity; do
        openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
            -subj "/CN=MOS-development-$domain" \
            -keyout "/keys/$domain/signer.key.pem" -out "/keys/$domain/signer.cert.pem" 2>/dev/null
    done
    openssl genpkey -algorithm ED25519 -out /keys/updates/signer.key.pem
    openssl pkey -in /keys/updates/signer.key.pem -pubout -outform DER | tail -c 32 | base64 -w0 > /keys/updates/public.key
    printf "DEVELOPMENT-GRADE\nDOMAINS=boot verity updates\n" > /keys/GENERATED
    chmod 0644 /keys/boot/*.cert.pem /keys/verity/*.cert.pem /keys/updates/public.key /keys/GENERATED
'
# mica-build-side: host
install -m 0644 "$repo/meta.example/updates/manifest.json" "$output/updates/manifest.json"
echo "Development boot, content and metadata signing inputs created at $output"
