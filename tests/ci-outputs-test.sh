#!/usr/bin/env bash
# tools/ci-outputs.sh: output tars packed per job unpack the same from a
# directory holding one of them (a board release) or several (CI), and a
# missing expected tar is refused rather than taken for a reused component.
set -euo pipefail
cd "$(dirname "$0")/.."
PASS_N=0; FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
mkdir -p tmp
T="$(mktemp -d "$(pwd)/tmp/ci-outputs-test.XXXXXX")"
trap 'rm -rf "${T}"; rm -rf _out/ci-outputs-test _out/kernel-ci-outputs-test.tar _out/pool-ci-outputs-test.tar' EXIT

mkdir -p _out/ci-outputs-test/kernel _out/ci-outputs-test/debs/amd64
echo kernel >_out/ci-outputs-test/kernel/Image
echo pool >_out/ci-outputs-test/debs/amd64/Packages
bash tools/ci-outputs.sh pack kernel-ci-outputs-test ci-outputs-test/kernel >/dev/null
bash tools/ci-outputs.sh pack pool-ci-outputs-test ci-outputs-test/debs/amd64 >/dev/null
mkdir -p "${T}/one" "${T}/two"
cp _out/pool-ci-outputs-test.tar "${T}/one/"
cp _out/pool-ci-outputs-test.tar _out/kernel-ci-outputs-test.tar "${T}/two/"
rm -rf _out/ci-outputs-test

if bash tools/ci-outputs.sh unpack "${T}/one" pool-ci-outputs-test >/dev/null && [ "$(cat _out/ci-outputs-test/debs/amd64/Packages)" = pool ]; then pass "one artifact: the pool lands under _out/"; else fail "one artifact"; fi
rm -rf _out/ci-outputs-test
if bash tools/ci-outputs.sh unpack "${T}/two" pool-ci-outputs-test kernel-ci-outputs-test >/dev/null && [ -f _out/ci-outputs-test/kernel/Image ] && [ -f _out/ci-outputs-test/debs/amd64/Packages ]; then pass "several artifacts: each under _out/"; else fail "several artifacts"; fi
if out="$(bash tools/ci-outputs.sh unpack "${T}/one" pool-ci-outputs-test kernel-ci-outputs-test 2>&1)"; then fail "a missing expected tar was accepted"
elif [[ "${out}" == *"kernel-ci-outputs-test.tar is missing"* ]]; then pass "a missing expected tar: refused"; else fail "missing tar: ${out}"; fi
mkdir -p "${T}/none"
if bash tools/ci-outputs.sh unpack "${T}/none" >/dev/null 2>&1; then fail "an empty download was accepted"; else pass "no output tar at all: refused"; fi

# tools/boards.sh bundle-is: the ASSEMBLED shape, which `make offline` must
# produce and a consumer fetches from a release. Built here from outputs.tsv
# itself rather than from a kernel build, so the check is exercised on every
# run instead of only on a machine that has just built four boards.
for board in $(bash tools/boards.sh list); do
    B="${T}/bundle-${board}"
    while IFS= read -r path; do
        mkdir -p "${B}/$(dirname "${path}")"
        : >"${B}/${path}"
    done < <(grep -v '^#' "boards/${board}/outputs.tsv" | awk -F'\t' '$1 == "file" { print $3 }')
    if bash tools/boards.sh bundle-is "${board}" "${B}" 2>/dev/null; then
        pass "bundle-is accepts ${board}'s whole bundle"
    else
        fail "bundle-is refuses a ${board} bundle holding exactly its outputs.tsv files"
    fi
    # One file per direction, so each refusal is provably about its own defect.
    : >"${B}/unexpected-file"
    if bash tools/boards.sh bundle-is "${board}" "${B}" 2>/dev/null; then
        fail "bundle-is accepts a ${board} bundle with a file outputs.tsv does not list"
    else
        pass "bundle-is refuses an unlisted file in ${board}'s bundle"
    fi
    rm "${B}/unexpected-file"
    rm "${B}/board.env"
    if bash tools/boards.sh bundle-is "${board}" "${B}" 2>/dev/null; then
        fail "bundle-is accepts a ${board} bundle missing board.env"
    else
        pass "bundle-is refuses a missing file in ${board}'s bundle"
    fi
done

echo "ci-outputs-test: ${PASS_N} passed, ${FAIL_N} failed"
[ "${FAIL_N}" -eq 0 ]
