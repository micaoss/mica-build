#!/bin/bash
# mica-build-side: container -- bound both expanded and transported payload bytes.
set -euo pipefail

validate_payload() (
    set -euo pipefail
    local packed=$1 original=$2 limit=$3 expanded
    test -s "$packed" || return 1
    test "$(stat -c%s "$packed")" -le "$limit" || return 1
    test -s "$original" || return 1
    test "$(stat -c%s "$original")" -le "$limit" || return 1
    expanded=$(mktemp)
    trap 'rm -f "$expanded"' EXIT
    # Bound disk output independently of the advertised zstd content size.
    # pipefail also rejects checksum failures and truncated/trailing garbage.
    zstd --decompress --stdout --quiet --memory=128MB "$packed" |
        head -c "$((limit + 1))" > "$expanded" || return 1
    test "$(stat -c%s "$expanded")" -le "$limit" || return 1
    cmp "$original" "$expanded"
)

compress_payload() (
    set -euo pipefail
    local original=$1 packed=$2 limit=$3
    test -s "$original" || return 1
    test "$(stat -c%s "$original")" -le "$limit" || return 1
    # One thread, a fixed level and checksum; never inherit ZSTD_* tuning.
    env -u ZSTD_CLEVEL -u ZSTD_NBTHREADS zstd -q -T1 -19 --check "$original" -o "$packed" || return 1
    validate_payload "$packed" "$original" "$limit"
)
