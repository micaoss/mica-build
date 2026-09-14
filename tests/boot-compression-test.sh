#!/usr/bin/env bash
# Run inside the pinned boot tools container with this checkout at /src.
set -euo pipefail
source /src/boot/compression.sh
work=$(mktemp -d)
trap 'rm -r "$work"' EXIT
printf '070701 deterministic archive fixture\n' > "$work/archive"
compress_payload "$work/archive" "$work/first.zst" 67108864
compress_payload "$work/archive" "$work/second.zst" 67108864
cmp "$work/first.zst" "$work/second.zst"
validate_payload "$work/first.zst" "$work/archive" 67108864
refuses() {
    if "$@"; then echo "unexpected compression acceptance: $*" >&2; exit 1; fi
}
head -c -1 "$work/first.zst" > "$work/truncated.zst"
printf 'invalid zstd bytes' > "$work/malformed.zst"
refuses validate_payload "$work/truncated.zst" "$work/archive" 67108864
refuses validate_payload "$work/malformed.zst" "$work/archive" 67108864
printf 'changed signed payload\n' > "$work/changed"
refuses validate_payload "$work/first.zst" "$work/changed" 67108864
truncate -s 67108865 "$work/oversized"
refuses compress_payload "$work/oversized" "$work/oversized.zst" 67108864
refuses validate_payload "$work/oversized" "$work/archive" 67108864
# A small compressed frame must not hide an expanded archive above the limit.
zstd -q -T1 -3 "$work/oversized" -o "$work/bomb.zst"
refuses validate_payload "$work/bomb.zst" "$work/archive" 67108864
sha256sum "$work/archive" "$work/first.zst"
printf '%s\n' BOOT_COMPRESSION_PASS
