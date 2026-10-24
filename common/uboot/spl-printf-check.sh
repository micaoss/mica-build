#!/usr/bin/env bash
# Over a built SPL: its strings carry no `%ll` conversion. U-Boot's tiny-printf
# takes a single `l`; on `%llx` it consumes the wrong argument and every
# argument after it shifts, so a following `%s` dereferences a number (the
# ssd202d SPL hung silently right after the IPL banner on exactly that). Only
# the binary is read: a `%ll` in a debug() line of a source the SPL compiles
# never reaches it, and is not what tiny-printf formats.
#
#   spl-printf-check.sh <spl-binary>...
#
# Exit 1 names every offending string.
set -euo pipefail
[ "$#" -ge 1 ] || { echo 'usage: spl-printf-check.sh <spl-binary>...' >&2; exit 2; }
conversion='%[-+ #0]*[0-9*]*(\.[0-9*]+)?ll[diouxXn]'
found=0
for b in "$@"; do
    [ -f "$b" ] || { echo "error: no SPL binary $b; this check runs after the SPL is built" >&2; exit 1; }
    if hits="$(strings -a "$b" | grep -E "${conversion}")"; then
        while IFS= read -r line; do echo "error: SPL binary ${b}: ${line}"; done <<<"${hits}"
        found=1
    fi
done
if [ "${found}" -ne 0 ]; then
    echo "error: the SPL carries %ll conversions (above); tiny-printf takes a single l, so write %lx/%ld (long is 64-bit on arm64) or %x with a narrower cast" >&2
    exit 1
fi
echo "spl-printf: no %ll in $*"
