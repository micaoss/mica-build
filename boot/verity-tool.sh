#!/usr/bin/env bash
# Sign a root hash with pinned tooling: an RSA-2048 CMS signature over the
# 64-byte hex root hash, verified against the public certificate. Staging a
# public trust certificate into a kernel or U-Boot build is mica-boards'.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/.." && pwd)"
die() { echo "verity-tool: $*" >&2; exit 1; }
command -v docker >/dev/null || die 'docker is required'
command -v realpath >/dev/null || die 'realpath is required'
image="$(bash "${ROOT}/tools/from.sh" --ref IMAGE_MICA_BUILD_BASE)"

# Docker bind sources are host paths, including when this checkout is in station.
host_path() {
    case "$1" in /work/*) printf '/srv/station/work/%s\n' "${1#/work/}" ;; /root/*) printf '/srv/station/root/%s\n' "${1#/root/}" ;; *) printf '%s\n' "$1" ;; esac
}
input() { [ -f "$1" ] && [ -s "$1" ] || die "explicit input is missing: $1"; realpath "$1"; }

mode="${1:-}"
case "${mode}" in
    sign)
        [ "$#" -eq 5 ] || die 'usage: verity-tool.sh sign ROOTHASH PRIVATE_KEY CERTIFICATE OUTPUT'
        hash="$(input "$2")"; key="$(input "$3")"; cert="$(input "$4")"
        [ ! -e "$5" ] && [ ! -L "$5" ] || die 'signature output already exists'
        mkdir -p "$(dirname "$5")"
        output="$(realpath -m "$5")"
        parent="$(dirname "${output}")"
        ;;
    *) die 'usage: verity-tool.sh sign ROOTHASH PRIVATE_KEY CERTIFICATE OUTPUT' ;;
esac
temporary="$(mktemp -d "${parent}/.verity.XXXXXX")"
cleanup() {
    rm -f "${temporary}/signer.cert.pem" "${temporary}/signature"
    rmdir "${temporary}" 2>/dev/null || true
}
trap cleanup EXIT
args=(--rm --label ai-agent=true --network traefik --name "ai-agent-verity-tool-$$"
    --user "$(id -u):$(id -g)"
    -v "$(host_path "${HERE}/verity-tool-inner.sh"):/tool.sh:ro"
    -v "$(host_path "${cert}"):/certificate.pem:ro"
    -v "$(host_path "${temporary}"):/output")
args+=(-v "$(host_path "${hash}"):/roothash:ro" -v "$(host_path "${key}"):/private.pem:ro")
docker run "${args[@]}" --entrypoint /bin/bash "${image}" /tool.sh "${mode}"
ln "${temporary}/signature" "${output}"
