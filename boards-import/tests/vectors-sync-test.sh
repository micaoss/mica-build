#!/usr/bin/env bash
# tests/vectors/ IS mica's vector directory at tools/vectors.pin, minus the
# paths tests/vectors/excluded.tsv declares, and this refuses any other
# difference in either direction.
#
#   bash tests/vectors-sync-test.sh
#
# WHY IT EXISTS. A copy of somebody else's conformance suite goes stale in a
# way nothing here can feel: every vector passes, the count looks defensible,
# and the copy is a year behind. Measured on 2026-09-20, this repository's copy
# was canonical at f742615 minus 14 files -- and eight of its own fixtures still
# used `x64`, the board name THIS repository retired on 2026-09-16, four days
# after the rename and in the one place where no copy can be blamed.
#
# A PROVENANCE COMMENT IS NOT THIS. The copy carried one, naming the commit it
# came from, and the comment was right while the content had moved on around it;
# mica-system-base carried one naming a commit where the file had 69 rows while
# its vectors were byte-current. A line nobody rereads records what somebody
# believed, which is the same defect as the rest of today: an input somebody
# authored sitting where a reader expects an output something checked.
#
# COMPARED AS BLOBS, NOT AS A MANIFEST. A name comparison gave a confident wrong
# provenance for this very directory on 2026-09-20 -- the names matched an older
# revision because the content had been re-taken while the SET stayed where it
# was. Only sha256 over every file answers that.
set -euo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"
PIN=tools/vectors.pin
VECTORS=tests/vectors
EXCLUDED="${VECTORS}/excluded.tsv"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# The pin is held to its own format by the same reader that reads every other
# pin here, over the vectors mica publishes for it.
if [ "$(bash tools/check-lock.sh vectors-pin "${PIN}")" = valid ]; then
    pass "${PIN} is a valid mica-vectors-pin v1"
else
    fail "${PIN} is not a valid mica-vectors-pin v1: $(bash tools/check-lock.sh vectors-pin "${PIN}" 2>&1)"
    echo "vectors-sync-test: ${PASS} passed, ${FAIL} failed"
    exit 1
fi
REPOSITORY="$(sed -n 's/^REPOSITORY=//p' "${PIN}")"
COMMIT="$(sed -n 's/^COMMIT=//p' "${PIN}")"

mkdir -p "${REPO_ROOT}/tmp"
T="$(mktemp -d "${REPO_ROOT}/tmp/vectors-sync.XXXXXX")"
trap 'rm -rf "${T}"' EXIT

# THE REACH, BEFORE ANY CLAIM ABOUT WHAT IS OR IS NOT THERE. A failed fetch and
# an empty upstream directory are the same empty list, and the second would make
# every assertion below vacuously true.
URL="https://codeload.github.com/micaoss/${REPOSITORY}/tar.gz/${COMMIT}"
curl -fsSL --connect-timeout 5 --max-time 120 "${URL}" -o "${T}/src.tgz" || {
    echo "FAIL: ${URL} did not answer. This gate compares against ${REPOSITORY} at ${COMMIT} and cannot be skipped: a comparison that did not fetch reports agreement." >&2
    exit 1
}
mkdir -p "${T}/canon"
tar -xzf "${T}/src.tgz" -C "${T}/canon" --strip-components=1 || { echo "FAIL: the archive of ${COMMIT} did not unpack" >&2; exit 1; }
CANON="${T}/canon/docs/design/release-lock/vectors"
[ -d "${CANON}" ] || { echo "FAIL: ${REPOSITORY} at ${COMMIT} has no docs/design/release-lock/vectors" >&2; exit 1; }
(cd "${CANON}" && find . -type f | sed 's|^\./||' | sort) >"${T}/canon.list"
n_canon="$(wc -l <"${T}/canon.list")"
if [ "${n_canon}" -gt 0 ]; then
    pass "${REPOSITORY} at ${COMMIT} answers with ${n_canon} vector files"
else
    fail "${REPOSITORY} at ${COMMIT} carries no vector file, so every comparison below would hold over nothing"
    echo "vectors-sync-test: ${PASS} passed, ${FAIL} failed"
    exit 1
fi

# excluded.tsv: the declared subset. A path that left canonical takes its
# exclusion with it, or the reason outlives the thing it excused.
sed '/^#/d; /^$/d' "${EXCLUDED}" | cut -f1 | sort >"${T}/excluded.list"
n_excluded="$(wc -l <"${T}/excluded.list")"
[ "${n_excluded}" -gt 0 ] || fail "${EXCLUDED} declares no path, so the derivation below asserts nothing"
stale="$(comm -13 "${T}/canon.list" "${T}/excluded.list")"
if [ -z "${stale}" ]; then
    pass "all ${n_excluded} excluded paths exist in ${REPOSITORY} at ${COMMIT}"
else
    fail "${EXCLUDED} excuses paths that are not in canonical any more: $(tr '\n' ' ' <<<"${stale}")"
fi

# The set, both directions.
comm -23 "${T}/canon.list" "${T}/excluded.list" >"${T}/carried.list"
(cd "${VECTORS}" && find . -type f ! -name excluded.tsv | sed 's|^\./||' | sort) >"${T}/mine.list"
missing="$(comm -23 "${T}/carried.list" "${T}/mine.list")"
extra="$(comm -13 "${T}/carried.list" "${T}/mine.list")"
if [ -z "${missing}" ]; then
    pass "every canonical vector that is not excluded is carried ($(wc -l <"${T}/carried.list") files)"
else
    fail "canonical vectors neither carried nor excluded: $(tr '\n' ' ' <<<"${missing}")"
fi
if [ -z "${extra}" ]; then
    pass "no vector here is absent from canonical"
else
    fail "vectors here that canonical does not have: $(tr '\n' ' ' <<<"${extra}")"
fi

# The bytes. expected.tsv is DERIVED rather than copied, so it is compared
# against the derivation instead of against canonical's file.
differ=0
compared=0
while IFS= read -r rel; do
    [ "${rel}" != expected.tsv ] || continue
    [ -f "${VECTORS}/${rel}" ] || continue
    compared=$((compared + 1))
    cmp -s "${CANON}/${rel}" "${VECTORS}/${rel}" || { differ=$((differ + 1)); echo "  differs: ${rel}"; }
done <"${T}/carried.list"
if [ "${compared}" -gt 0 ] && [ "${differ}" = 0 ]; then
    pass "all ${compared} carried vector files are byte-identical to canonical"
else
    fail "${differ} of ${compared} carried vector files differ from canonical at ${COMMIT}"
fi

# expected.tsv: canonical's table with the excluded rows removed, in canonical's
# order. A row naming a DIRECTORY (the repos family) is excluded when every file
# under it is.
awk -F'\t' -v carried="${T}/carried.list" '
BEGIN { while ((getline p < carried) > 0) { have[p] = 1; n++; paths[n] = p } }
/^#/ { next }
{
    keep = ($1 in have)
    if (!keep) { pre = $1 "/"; for (i = 1; i <= n; i++) if (index(paths[i], pre) == 1) { keep = 1; break } }
    if (keep) print
}
' "${CANON}/expected.tsv" >"${T}/expected.derived"
grep -v '^#' "${VECTORS}/expected.tsv" >"${T}/expected.mine"
if diff -u "${T}/expected.derived" "${T}/expected.mine" >"${T}/expected.diff"; then
    pass "expected.tsv is canonical's table minus the excluded rows ($(wc -l <"${T}/expected.mine") rows)"
else
    fail "expected.tsv is not the derivation of canonical's table:"
    sed 's/^/    /' "${T}/expected.diff"
fi

echo "vectors-sync-test: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" = 0 ]
