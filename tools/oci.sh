#!/usr/bin/env bash
# Reads by digest only: anonymous from ghcr.io, or from an offline build's OCI layout.
#
#   bash tools/oci.sh manifest <ghcr.io/<owner>/<name>|local/<repository>>[:<tag>]@sha256:<hex>
#       the image manifest, hashed to its digest and kept under _out/cache/oci/<digest>.json; prints its path
#   bash tools/oci.sh blob <ghcr.io/<owner>/<name>|local/<repository>> <sha256> <out>
#       one blob into <out>, hashed to its digest
#
# A local/<repository> reference (an offline lock, mica:docs/design/release-lock.md
# section 6) resolves only inside <CHECKOUT>/_out/offline/oci/ of that
# repository's offline pin, and is refused under CI.
#
# A MANIFEST DIGEST IS NOT A CONTENT IDENTITY. It covers the annotations too,
# and those carry the release, the source commit and the build time, so the same
# bytes published twice have two digests. Anything asking "did this component
# change" compares LAYER digests out of the manifest this prints, never the
# reference it was fetched by.
#
# The tag of a reference is informational; the digest is what is read. A
# refused token, a status other than 200 or bytes other than the digest stop
# the read, with no fallback. MICA_OCI_CACHE overrides _out/cache/oci.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
CACHE="${MICA_OCI_CACHE:-${REPO_ROOT}/_out/cache/oci}"

die() { echo "oci.sh: error: $*" >&2; exit 1; }
for t in curl jq sha256sum; do
    command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"
done

mkdir -p "${REPO_ROOT}/_out"
WORK="$(mktemp -d "${REPO_ROOT}/_out/.oci.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT

get() { # <repository> <path> <out> <accept>
    local repository="$1" code token
    if [[ "${repository}" == local/* ]]; then
        [ -z "${CI:-}${GITHUB_ACTIONS:-}" ] || die "${repository} is an offline build; CI reads published releases only"
        local checkout
        checkout="$(python3 "${HERE}/locks.py" checkout "${repository#local/}")" || die "locks/ names no offline checkout of ${repository#local/} (see above)"
        [ -n "${checkout}" ] || die "locks/pins/${repository#local/}.pin is not an offline pin, so ${repository} names nothing"
        cp "${checkout}/_out/offline/oci/blobs/sha256/${2##*sha256:}" "$3" 2>/dev/null || die "${checkout}/_out/offline/oci holds no blob ${2##*/}"
        return 0
    fi
    code="$(curl -sS -o "${WORK}/token.json" -w '%{http_code}' --max-time 60 "https://ghcr.io/token?scope=repository:${repository}:pull&service=ghcr.io" || echo 000)"
    [ "${code}" = 200 ] || die "the token endpoint of ghcr.io answered ${code} for ${repository} (000: not reached)"
    token="$(jq -r '.token // .access_token // empty' "${WORK}/token.json")"
    [ -n "${token}" ] || die "ghcr.io issued no pull token for ${repository}"
    # A transport failure is retried at the same location; the bytes are checked against the digest either way.
    code="$(curl -sS -L --retry 3 --retry-all-errors -o "$3" -w '%{http_code}' --max-time 1800 -H "Authorization: Bearer ${token}" -H "Accept: $4" "https://ghcr.io/v2/${repository}/$2" || echo 000)"
    [ "${code}" = 200 ] || die "reading ghcr.io/${repository} $2 answered ${code} (000: not reached)"
}

case "${1:-}" in
manifest)
    [ "$#" -eq 2 ] && [[ "$2" =~ ^ghcr\.io/([a-z0-9-]+/[a-z0-9._-]+)(:[A-Za-z0-9._-]+)?@(sha256:[0-9a-f]{64})$ || "$2" =~ ^(local/[a-z0-9-]+)(:[A-Za-z0-9._-]+)?@(sha256:[0-9a-f]{64})$ ]] ||
        die "usage: manifest <ghcr.io/<owner>/<name>|local/<repository>>[:<tag>]@sha256:<hex>"
    repository="${BASH_REMATCH[1]}"; digest="${BASH_REMATCH[3]}"
    out="${CACHE}/${digest}.json"
    if [ ! -f "${out}" ] || [ "sha256:$(sha256sum "${out}" | cut -d' ' -f1)" != "${digest}" ]; then
        mkdir -p "${CACHE}"
        get "${repository}" "manifests/${digest}" "${out}.part" application/vnd.oci.image.manifest.v1+json
        [ "sha256:$(sha256sum "${out}.part" | cut -d' ' -f1)" = "${digest}" ] || { rm -f "${out}.part"; die "${repository} served a manifest for ${digest} with other bytes"; }
        mv "${out}.part" "${out}"
    fi
    printf '%s\n' "${out}"
    ;;
blob)
    [ "$#" -eq 4 ] && [[ "$3" =~ ^[0-9a-f]{64}$ ]] && [[ "$2" =~ ^ghcr\.io/([a-z0-9-]+/[a-z0-9._-]+)$ || "$2" =~ ^(local/[a-z0-9-]+)$ ]] ||
        die "usage: blob <ghcr.io/<owner>/<name>|local/<repository>> <sha256> <out>"
    get "${BASH_REMATCH[1]}" "blobs/sha256:$3" "$4.part" application/octet-stream
    [ "$(sha256sum "$4.part" | cut -d' ' -f1)" = "$3" ] || { rm -f "$4.part"; die "$2 served a blob for sha256:$3 with other bytes"; }
    mv "$4.part" "$4"
    ;;
*)
    die "usage: bash tools/oci.sh manifest <reference@digest> | blob <repository> <sha256> <out>"
    ;;
esac
