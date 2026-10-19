#!/usr/bin/env bash
# mica-build-side: container -- one pinned third-party archive, into the
# builder image's own filesystem.
#
#   fetch-archive.sh <sha256> <url> <dest>
#
# The sha256 and the url are the columns of a `source` row of
# locks/upstream.lock, handed in as build arguments. The row's URL is what this
# fetches, and the row's sha256 is what proves the bytes; the mirror
# (common/scripts/mirror.sh, MICA_MIRROR) is tried first because it answers
# where a vendor host may not, and is skipped silently when it does not answer.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common/scripts/mirror.sh
. "${HERE}/mirror.sh"

[ "$#" -eq 3 ] || { echo "usage: fetch-archive.sh <sha256> <url> <dest>" >&2; exit 1; }
SHA="$1" URL="$2" DEST="$3"
[[ "${SHA}" =~ ^[0-9a-f]{64}$ ]] || { echo "error: fetch-archive.sh: '${SHA}' is not a sha256" >&2; exit 1; }
[ -n "${URL}" ] || { echo "error: fetch-archive.sh: empty url for ${SHA}. An empty --build-arg reaches here as a fetch of nothing" >&2; exit 1; }

if mirror_get "blob/${SHA:0:2}/${SHA}" "${DEST}"; then
    got="$(mirror_sha256 "${DEST}")"
    [ "${got}" = "${SHA}" ] || {
        rm -f "${DEST}"
        echo "error: fetch-archive.sh: the mirror served ${got} for ${SHA}. A mirror is a source, not a trust anchor: wrong bytes are refused here rather than fetched again from ${URL}" >&2
        exit 1
    }
    if [ "${MIRROR_REDIRECTS}" != 0 ]; then
        echo "fetch-archive.sh: ${SHA:0:12} from the mirror, after ${MIRROR_REDIRECTS} redirect(s)"
    else
        echo "fetch-archive.sh: ${SHA:0:12} from the mirror"
    fi
    exit 0
fi

echo "fetch-archive.sh: ${SHA:0:12} not mirrored (${MIRROR_STATUS:-no mirror configured}), fetching ${URL}"
curl -L --fail --retry 3 -o "${DEST}" "${URL}"
got="$(mirror_sha256 "${DEST}")"
[ "${got}" = "${SHA}" ] || {
    rm -f "${DEST}"
    echo "error: fetch-archive.sh: ${URL} served ${got}, and locks/upstream.lock pins ${SHA}" >&2
    exit 1
}
