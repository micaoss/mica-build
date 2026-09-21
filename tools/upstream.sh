#!/usr/bin/env bash
# One field of a row of locks/upstream.lock, the third-party trees and archives
# the boards build from (mica:docs/design/release-lock.md section 4.1).
#
#   bash tools/upstream.sh git <name> url|ref|commit
#   bash tools/upstream.sh source <name> <amd64|arm64|all> version|sha256|url
#
# A missing row or field is an error naming it, so a build never runs on an
# empty pin.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${MICA_LOCKS_DIR:-${REPO_ROOT}/locks}/upstream.lock"
die() { echo "upstream.sh: error: $*" >&2; exit 1; }
[ -f "${LOCK}" ] || die "${LOCK} does not exist"

case "${1-}:$#" in
git:3)
    case "$3" in url) col=3 ;; ref) col=4 ;; commit) col=5 ;; *) die "a git row has url, ref and commit, not $3" ;; esac
    value="$(awk -F'\t' -v n="$2" -v c="${col}" '$1 == "git" && $2 == n { print $c }' "${LOCK}")"
    [ -n "${value}" ] || die "${LOCK} pins no git tree $2"
    ;;
source:4)
    case "$4" in version) col=4 ;; sha256) col=5 ;; url) col=6 ;; *) die "a source row has version, sha256 and url, not $4" ;; esac
    value="$(awk -F'\t' -v n="$2" -v a="$3" -v c="${col}" '$1 == "source" && $2 == n && $3 == a { print $c }' "${LOCK}")"
    [ -n "${value}" ] || die "${LOCK} pins no source $2 for $3"
    ;;
*) die "usage: bash tools/upstream.sh git <name> url|ref|commit | source <name> <amd64|arm64|all> version|sha256|url" ;;
esac
printf '%s\n' "${value}"
