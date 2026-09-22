#!/usr/bin/env bash
# Exercise the current development generator and all three independent domains.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
command -v docker >/dev/null
mkdir -p "$PWD/.tmp"
work=$(mktemp -d "$PWD/.tmp/trust-hygiene.XXXXXX")
trap 'rm -r "$work"' EXIT
# Inspect names only: no private bytes enter the output.
tracked=$(git ls-files '*.pk8' '*.key.pem' '*.p12')
[ -z "$tracked" ] || { echo 'FAIL: private-key filenames are tracked' >&2; exit 1; }
for file in meta/boot/signer.key.pem meta/verity/signer.key.pem meta/updates/signer.key.pem .tmp/signing/updates/signer.key.pem; do
    git check-ignore -q "$file"
done
bash boot/dev-keys.sh --out "$work/keys"
image=$(bash tools/from.sh --ref mica-build-env:base)
# mica-build-side: container-block -- pinned OpenSSL reads isolated test keys.
docker run --rm --label ai-agent=true --network traefik -v "$work/keys:/keys:ro" --entrypoint /bin/bash "$image" -ceu '
    set -o pipefail
    for domain in boot verity updates; do
        test "$(stat -c %a /keys/$domain/signer.key.pem)" = 600
        test "$(stat -c %a /keys/$domain)" = 700
        openssl pkey -in /keys/$domain/signer.key.pem -pubout -outform DER > /tmp/$domain.pub
    done
    ! cmp -s /tmp/boot.pub /tmp/verity.pub
    ! cmp -s /tmp/boot.pub /tmp/updates.pub
    ! cmp -s /tmp/verity.pub /tmp/updates.pub
    for domain in boot verity; do
        openssl x509 -in /keys/$domain/signer.cert.pem -pubkey -noout |
            openssl pkey -pubin -outform DER > /tmp/$domain.cert.pub
        cmp /tmp/$domain.pub /tmp/$domain.cert.pub
    done
    tail -c 32 /tmp/updates.pub | base64 -w0 > /tmp/metadata.base64
    cmp /tmp/metadata.base64 /keys/updates/public.key
    grep -qx DEVELOPMENT-GRADE /keys/GENERATED
'
# mica-build-side: host
cp "$work/keys/GENERATED" "$work/marker-before"
if bash boot/dev-keys.sh --out "$work/keys" > "$work/refusal.log" 2>&1; then
    echo 'FAIL: generator overwrote an existing output' >&2; exit 1
fi
grep -q 'key output already exists' "$work/refusal.log"
cmp "$work/marker-before" "$work/keys/GENERATED"
ln -s keys "$work/alias"
if bash boot/dev-keys.sh --out "$work/alias" > "$work/alias-refusal.log" 2>&1; then
    echo 'FAIL: generator accepted an existing output alias' >&2; exit 1
fi
bash boot/init-keys.sh --out "$work/initialized"
snapshot() {
    (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum)
}
snapshot "$work/initialized" > "$work/before"
bash boot/init-keys.sh --out "$work/initialized"
snapshot "$work/initialized" > "$work/after"
cmp "$work/before" "$work/after"
mkdir "$work/empty"
bash boot/init-keys.sh --out "$work/empty" > "$work/concurrent-a.log" 2>&1 &
first=$!
bash boot/init-keys.sh --out "$work/empty" > "$work/concurrent-b.log" 2>&1 &
second=$!
wait "$first"
wait "$second"
bash boot/init-keys.sh --out "$work/empty"
for fault in incomplete mismatch symlink permissions; do
    cp -a "$work/initialized" "$work/$fault"
    case "$fault" in
    incomplete) mv "$work/$fault/verity/signer.cert.pem" "$work/missing-cert";;
    mismatch) cp "$work/keys/boot/signer.cert.pem" "$work/$fault/boot/signer.cert.pem";;
    symlink) mv "$work/$fault/boot" "$work/linked-boot"; ln -s ../linked-boot "$work/$fault/boot";;
    permissions) chmod 0644 "$work/$fault/boot/signer.key.pem";;
    esac
    snapshot "$work/$fault" > "$work/$fault-before"
    if bash boot/init-keys.sh --out "$work/$fault" > "$work/$fault.log" 2>&1; then
        echo "FAIL: initializer accepted $fault" >&2; exit 1
    fi
    snapshot "$work/$fault" > "$work/$fault-after"
    cmp "$work/$fault-before" "$work/$fault-after"
done
if bash boot/init-keys.sh --out "$work/alias" > "$work/init-alias.log" 2>&1; then
    echo 'FAIL: initializer accepted an output alias' >&2; exit 1
fi
echo 'TRUST_DOMAIN_HYGIENE_PASS: separate boot/content/metadata keys, matching public inputs, private permissions, no overwrite'
