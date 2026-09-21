#!/usr/bin/env bash
# The relinked profile kernel of a FIT board against a clean build of that
# profile: the same files, every one byte-identical. Run by a board's
# `make kernel-profile-test` after `make kernel`.
#
#   profile-test.sh <relinked profile dir> <clean profile dir>
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: profile-test.sh <relinked profile dir> <clean profile dir>" >&2; exit 1; }
RELINKED="$1" CLEAN="$2"
for d in "${RELINKED}" "${CLEAN}"; do [ -d "${d}" ] || { echo "error: ${d} is not a directory" >&2; exit 1; }; done
relinked_files="$(cd "${RELINKED}" && find . -type f | LC_ALL=C sort)"
clean_files="$(cd "${CLEAN}" && find . -type f | LC_ALL=C sort)"
[ "${relinked_files}" = "${clean_files}" ] || { echo "FAIL: the relinked and the clean build hold different files: $(diff <(echo "${relinked_files}") <(echo "${clean_files}") | tr '\n' ' ')" >&2; exit 1; }
fail=0
while IFS= read -r f; do
    if cmp -s "${RELINKED}/${f}" "${CLEAN}/${f}"; then
        echo "PASS: ${f#./} byte-identical ($(sha256sum "${CLEAN}/${f}" | cut -c1-16))"
    else
        echo "FAIL: ${f#./} differs: relinked $(sha256sum "${RELINKED}/${f}" | cut -c1-16), clean $(sha256sum "${CLEAN}/${f}" | cut -c1-16)"
        fail=1
    fi
done <<<"${clean_files}"
[ "${fail}" = 0 ] && echo "profile-test: the relinked kernel is the clean build ($(grep -c . <<<"${clean_files}") files)"
exit "${fail}"
