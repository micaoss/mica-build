#!/usr/bin/env bash
# The source of an imported repository at the commit its release names.
#
#   bash tools/source.sh <repository>
#
#   reads   locks/ (tools/locks.py release <repository>: the commit of its release row, and for an
#           offline pin the CHECKOUT it names)
#   writes  _out/src/<repository>/            a clean checkout of exactly that commit
#
# The full 40-hex commit is the pin: git refuses a commit whose object does not
# hash to it, and the checkout is refused unless HEAD is that commit and the
# tree is clean. The repository is public; no credential is used.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"

die() { echo "source.sh: error: $*" >&2; exit 1; }
[ "$#" -eq 1 ] && [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "usage: bash tools/source.sh <repository>"
REPOSITORY="$1"
COMMIT="$(python3 "${HERE}/locks.py" release "${REPOSITORY}" | cut -f2)" || die "locks/ pins no release of ${REPOSITORY} (see above)"
# An offline pin names its checkout, which is read, never written; tools/locks.py refuses one under CI.
URL="$(python3 "${HERE}/locks.py" pin "${REPOSITORY}" | sed -n 's/^CHECKOUT=//p')"
[[ "${COMMIT}" =~ ^[0-9a-f]{40}$ ]] || die "no 40-hex commit for ${REPOSITORY}"
URL="${URL:-https://github.com/micaoss/${REPOSITORY}.git}"
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
