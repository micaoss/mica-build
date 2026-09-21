#!/usr/bin/env bash
# Stage a public certificate bundle as the trust context a kernel or U-Boot
# build embeds.
#
#   bash common/trust/stage.sh CERTIFICATE_BUNDLE CONTEXT_PARENT
#   -> prints CONTEXT_PARENT/<sha256>, a directory holding exactly
#      signer.cert.pem (the bundle, byte for byte) and sha256 (its digest)
#
# The bundle is validated by stage-inner.sh in the mica-build-env base image
# (locks/mica-build-env.lock, which carries openssl): non-empty PEM certificates only, no
# private key or other material, parseable by OpenSSL. This repository takes
# only public certificates (VERITY_TRUST_CERT, FIT_TRUST_CERT); the private
# keys and signing stay with the assembly. The container needs no network.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../.." && pwd)"
die() { echo "trust-stage: $*" >&2; exit 1; }
[ "$#" -eq 2 ] || die 'usage: stage.sh CERTIFICATE_BUNDLE CONTEXT_PARENT'
command -v docker >/dev/null || die 'docker is required'
command -v realpath >/dev/null || die 'realpath is required'
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) die 'unsupported build architecture' ;; esac
image="$(bash "${ROOT}/tools/from.sh" --arch="${arch}" --ref base)"

# Docker bind sources are host paths, including when this checkout is in station.
host_path() {
    case "$1" in /work/*) printf '/srv/station/work/%s\n' "${1#/work/}" ;; /root/*) printf '/srv/station/root/%s\n' "${1#/root/}" ;; *) printf '%s\n' "$1" ;; esac
}
[ -f "$1" ] && [ -s "$1" ] || die "explicit input is missing: $1"
cert="$(realpath "$1")"
mkdir -p "$2"
parent="$(realpath "$2")"

temporary="$(mktemp -d "${parent}/.trust.XXXXXX")"
cleanup() {
    rm -f "${temporary}/signer.cert.pem" "${temporary}/sha256"
    rmdir "${temporary}" 2>/dev/null || true
}
trap cleanup EXIT
docker run --rm --label ai-agent=true --network none --name "ai-agent-trust-stage-$$" \
    --user "$(id -u):$(id -g)" \
    -v "$(host_path "${HERE}/stage-inner.sh"):/stage.sh:ro" \
    -v "$(host_path "${cert}"):/certificate.pem:ro" \
    -v "$(host_path "${temporary}"):/output" \
    --entrypoint /bin/bash "${image}" /stage.sh || die "the certificate bundle was refused: $1"
digest="$(cat "${temporary}/sha256")"
[[ "${digest}" =~ ^[0-9a-f]{64}$ ]] || die 'invalid staged certificate digest'
destination="${parent}/${digest}"
if ! mv -T "${temporary}" "${destination}" 2>/dev/null; then
    [ -d "${destination}" ] && [ ! -L "${destination}" ] || die 'invalid existing trust context'
    cmp -s "${temporary}/signer.cert.pem" "${destination}/signer.cert.pem" || die 'existing trust context differs'
    cmp -s "${temporary}/sha256" "${destination}/sha256" || die 'existing trust digest differs'
    [ "$(find "${destination}" -mindepth 1 -maxdepth 1 | wc -l)" -eq 2 ] || die 'unexpected material in trust context'
fi
printf '%s\n' "${destination}"
