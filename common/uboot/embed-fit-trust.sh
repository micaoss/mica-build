#!/usr/bin/env bash
# mica-build-side: container -- replace the control FDT's required public FIT keys.
set -euo pipefail
[ "$#" -eq 4 ] || { echo 'usage: embed-fit-trust.sh CONTROL_DTB CERTIFICATE_BUNDLE OUTPUT_DTB TOOLS_DIRECTORY' >&2; exit 2; }
control=$1
bundle=$2
output=$3
tools=$4
count=$(grep -c -- '-----BEGIN CERTIFICATE-----' "$bundle")
[ "$count" -ge 1 ] && [ "$count" -le 8 ] || { echo 'error: require one to eight public boot keys' >&2; exit 1; }
! grep -q 'PRIVATE KEY' "$bundle"
work=$(mktemp -d "$(dirname "$output")/.fit-trust.XXXXXX")
trap 'rm -rf "$work"' EXIT
cp "$control" "$work/control.dtb"
if fdtget -l "$work/control.dtb" / | grep -cx signature >/dev/null; then fdtput -r "$work/control.dtb" /signature; fi
awk -v directory="$work" '
    /-----BEGIN CERTIFICATE-----/ { n++; path=sprintf("%s/input-%d.pem", directory, n) }
    path { print >path }
    /-----END CERTIFICATE-----/ { close(path); path="" }
' "$bundle"
for certificate in "$work"/input-*.pem; do
    openssl x509 -in "$certificate" -noout -text > "$work/certificate.txt"
    grep -q 'Public Key Algorithm: rsaEncryption' "$work/certificate.txt"
    grep -q 'Public-Key: (2048 bit)' "$work/certificate.txt"
    id=$(openssl x509 -in "$certificate" -pubkey -noout | openssl pkey -pubin -outform DER | sha256sum | cut -d' ' -f1)
    [ ! -e "$work/$id.crt" ] || { echo 'error: duplicate public boot key' >&2; exit 1; }
    cp "$certificate" "$work/$id.crt"
    "$tools/fdt_add_pubkey" -a sha256,rsa2048 -k "$work" -n "$id" -r conf "$work/control.dtb"
    test "$(fdtget "$work/control.dtb" "/signature/key-$id" required)" = conf
    test "$(fdtget "$work/control.dtb" "/signature/key-$id" algo)" = sha256,rsa2048
done
fdtput -t s "$work/control.dtb" /signature required-mode any
test "$(fdtget -l "$work/control.dtb" /signature | wc -l)" = "$count"
cp "$work/control.dtb" "$output"
echo "FIT_REQUIRED_PUBLIC_KEYS: $count"
