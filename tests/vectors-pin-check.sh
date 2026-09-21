#!/usr/bin/env bash
# The vectors this tree tests against, AGAINST THE COMMIT IT CLAIMS THEM FROM.
#
#   bash tests/vectors-pin-check.sh      (make os-vectors-pin-check; gh, network)
#
# WHY A COPY NEEDED A GATE. tests/release-lock/vectors/ was copied out of
# mica:docs/design/release-lock/vectors and then left alone. Measured on
# 2026-09-20 it was SIXTEEN FILES BEHIND: the five `data-*` vectors for a row
# this tree had already implemented, the board vector under its post-rename
# name, and derived-from.tsv. Every one of those absences read as a pass --
# release-lock-test.sh walks expected.tsv, and a vector that is not in the copy
# is not in the copy's expected.tsv either, so nothing was ever missing FROM
# THE POINT OF VIEW OF THE TEST. A copy with no pin cannot go stale loudly.
#
# THIS GATE NEEDS THE NETWORK AND SAYS SO RATHER THAN SKIPPING. A check that
# passes when it could not look is the defect this tree keeps finding in
# itself, so an absent `gh` is a failure here and not a quiet success.
set -euo pipefail
cd "$(dirname "$0")/.."
PIN=tests/release-lock/vectors.pin
VECTORS=tests/release-lock/vectors

[ "$(python3 tools/locks.py vectors-pin "${PIN}")" = valid ] ||
    { echo "error: ${PIN} is not a valid mica-vectors-pin v1 file" >&2; exit 1; }
repository="$(sed -n 's/^REPOSITORY=//p' "${PIN}")"
commit="$(sed -n 's/^COMMIT=//p' "${PIN}")"
command -v gh >/dev/null ||
    { echo "error: gh is required to read ${repository} at ${commit}; this gate does not pass without looking" >&2; exit 1; }

# _out/ is git-ignored and does not exist in a fresh checkout, which is every
# CI run: this script is in the lint job, which builds nothing before it.
mkdir -p "$PWD/_out"
work="$(mktemp -d "$PWD/_out/vectors-pin.XXXXXX")"
trap 'rm -rf "${work}"' EXIT
# The whole tree in one request, at the pinned commit rather than at a branch.
gh api "repos/micaoss/${repository}/tarball/${commit}" > "${work}/tree.tar.gz"
tar -xzf "${work}/tree.tar.gz" -C "${work}"
upstream="$(find "${work}" -type d -path '*/docs/design/release-lock/vectors' -print -quit)"
[ -n "${upstream}" ] ||
    { echo "error: ${repository} at ${commit} carries no docs/design/release-lock/vectors" >&2; exit 1; }

# `diff -r` and not a digest: a digest says THAT they differ, and the whole
# reason this drifted is that nobody could see WHAT differed.
if diff -r "${upstream}" "${VECTORS}"; then
    echo "RESULT: PASS ($(find "${VECTORS}" -type f | wc -l) files identical to ${repository} ${commit})"
else
    echo "RESULT: FAIL (${VECTORS} differs from ${repository} ${commit}; copy that tree or move the pin)" >&2
    exit 1
fi
