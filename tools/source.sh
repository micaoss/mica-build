#!/usr/bin/env bash
# The source of an imported repository at the commit its release names.
#
#   bash tools/source.sh <repository>
#
#   reads   deps/releases/<repository>.json   (commit, and the organisation its url names), or for
#           mica-system-base system-base.lock (the commit its pool manifests name)
#   writes  _out/src/<repository>/            a clean checkout of exactly that commit
#
# The full 40-hex commit is the pin: git refuses a commit whose object does not
# hash to it, and the checkout is refused unless HEAD is that commit and the
# tree is clean. The repository is public; no credential is used.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
RELEASES="${MICA_RELEASE_DIR:-${REPO_ROOT}/deps/releases}"

die() { echo "source.sh: error: $*" >&2; exit 1; }
[ "$#" -eq 1 ] && [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "usage: bash tools/source.sh <repository>"
REPOSITORY="$1"
if [ "${REPOSITORY}" = mica-system-base ]; then
    COMMIT="$(bash "${HERE}/system-base.sh" commit)" || die "system-base.lock names no readable release commit (see above)"
    ORG=micaoss
else
    RECORD="${RELEASES}/${REPOSITORY}.json"
    [ -f "${RECORD}" ] || die "${RECORD} does not exist: ${REPOSITORY} has no release this tree imports"
    COMMIT="$(jq -r .commit "${RECORD}")"
    if [ "$(jq -r .transport "${RECORD}")" = local ]; then
        # A local record (tools/local-pins.sh) names its checkout, which is read, never written.
        [ -z "${GITHUB_ACTIONS:-}" ] || die "${RECORD} is a local record; CI reads published releases only"
        URL="$(jq -r .checkout "${RECORD}")"
    else
        ORG="$(jq -r '(.url // "") | capture("^https://github\\.com/(?<o>[A-Za-z0-9-]+)/").o // empty' "${RECORD}")"
        [ -n "${ORG}" ] || die "${RECORD} names no GitHub release url, so the repository's organisation is unknown"
    fi
fi
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || die "no 40-hex commit for ${REPOSITORY}"
URL="${URL:-https://github.com/${ORG}/${REPOSITORY}.git}"
DEST="${REPO_ROOT}/_out/src/${REPOSITORY}"

if [ ! -d "${DEST}/.git" ]; then
    rm -rf "${DEST}"
    mkdir -p "${DEST}"
    git -C "${DEST}" init --quiet
fi
git -C "${DEST}" cat-file -e "${COMMIT}^{commit}" 2>/dev/null ||
    git -C "${DEST}" fetch --quiet --depth 1 "${URL}" "${COMMIT}" ||
    die "could not fetch ${COMMIT} from ${URL} (see git's message above)"
git -C "${DEST}" checkout --quiet --force --detach "${COMMIT}"
[ "$(git -C "${DEST}" rev-parse HEAD)" = "${COMMIT}" ] || die "${DEST} is not at ${COMMIT} after checkout"
git -C "${DEST}" clean --quiet -fdx
[ -z "$(git -C "${DEST}" status --porcelain)" ] || die "${DEST} is not clean after checkout"
echo "source.sh: ${REPOSITORY} at ${COMMIT} in ${DEST#"${REPO_ROOT}"/}"
