#!/usr/bin/env bash
# tools/locks.py against the vectors of mica:docs/design/release-lock.md section 9,
# copied unchanged into tests/release-lock/vectors/: every lock, upstream and pins
# vector must be valid, or refused by exactly its rule, as expected.tsv lists.
# The repos/ vectors belong to tools/repos.sh, which this tree does not have yet.
#
#   bash tests/release-lock-test.sh      (make os-release-lock-test; python3, no network)
set -euo pipefail
cd "$(dirname "$0")/.."
VECTORS=tests/release-lock/vectors
PASS_N=0
FAIL_N=0
listed=" "
while IFS=$'\t' read -r path result rule mode; do
    case "${path}" in '#'* | '') continue ;; esac
    listed="${listed}${path} "
    case "${path}" in
    lock/*) got="$(python3 tools/locks.py lock "${VECTORS}/${path}" 2>/dev/null || true)" ;;
    upstream/*) got="$(python3 tools/locks.py upstream "${VECTORS}/${path}" 2>/dev/null || true)" ;;
    pins/*) got="$(python3 tools/locks.py pins "${VECTORS}/${path}" "${mode}" 2>/dev/null || true)" ;;
    repos/*) continue ;;
    *) echo "FAIL: ${path}: no reader for this vector"; FAIL_N=$((FAIL_N + 1)); continue ;;
    esac
    want="${result}"
    [ "${result}" = valid ] || want="refused ${rule}"
    if [ "${got}" = "${want}" ]; then
        PASS_N=$((PASS_N + 1))
    else
        echo "FAIL: ${path}: expected '${want}', got '${got}'"
        FAIL_N=$((FAIL_N + 1))
    fi
done <"${VECTORS}/expected.tsv"
# Every lock and upstream file under vectors/ is listed, so none is skipped silently.
while IFS= read -r f; do
    rel="${f#"${VECTORS}"/}"
    case "${rel}" in
    lock/*.lock | upstream/*.lock)
        case "${listed}" in *" ${rel} "*) ;; *) echo "FAIL: ${rel} is not listed in expected.tsv"; FAIL_N=$((FAIL_N + 1)) ;; esac ;;
    esac
done < <(find "${VECTORS}" -type f | LC_ALL=C sort)
echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) vectors)"
[ "${FAIL_N}" -eq 0 ]
