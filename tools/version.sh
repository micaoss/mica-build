#!/usr/bin/env bash
# The version stamp of this tree: <VERSION>+git<commit12>[.dirty]-1.
#
#   bash tools/version.sh
#
# VERSION is the repository's one-line release version; the stamp names the
# commit the components were made from, and `.dirty` a tree no commit
# reproduces (mica-build-env RULES.md 6).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
VERSION_FILE="${REPO_ROOT}/VERSION"

die() { echo "version.sh: error: $*" >&2; exit 1; }
[ "$#" -eq 0 ] || die "usage: bash tools/version.sh"
[ -f "${VERSION_FILE}" ] || die "${VERSION_FILE} does not exist"
[ "$(grep -c . "${VERSION_FILE}")" -eq 1 ] || die "${VERSION_FILE} must hold exactly one non-empty line"
VERSION="$(sed -n '1p' "${VERSION_FILE}" | tr -d '[:space:]')"
[[ "${VERSION}" =~ ^[0-9][A-Za-z0-9.~]*$ ]] || die "${VERSION_FILE} declares '${VERSION}', which is not a Debian upstream version"
git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1 || die "${REPO_ROOT} is not a git checkout, so there is no commit to stamp"
COMMIT="$(git -C "${REPO_ROOT}" rev-parse --short=12 HEAD)"
DIRTY=""
[ -z "$(git -C "${REPO_ROOT}" status --porcelain)" ] || DIRTY=".dirty"
echo "${VERSION}+git${COMMIT}${DIRTY}-1"
