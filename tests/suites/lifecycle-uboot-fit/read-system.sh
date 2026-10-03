#!/bin/bash
# Read unclean snapshots using the same pinned U-Boot ext4 implementation.
set -euo pipefail
work=${1:?absolute evidence directory required}
kernel=$(cat "$work/kernel-id")
candidate=$(cat "$work/candidate-id")
for name in cut-partial cut-files cut-published; do
    timeout -k 5 60 docker run --rm --label ai-agent=true --network traefik \
        -v "$work:/w" ai-agent/mica-uboot-sandbox -D -c \
        "host bind disk /w/$name.img; if ext4load host 0:0 1000000 /kernels/$kernel/boot.itb; then host save hostfs - 1000000 /w/$name.itb \${filesize}; else echo FIT_RETAINED_READ_FAILED; fi" \
        > "$work/$name.log" 2>&1
    test -f "$work/$name.itb"
    cmp "$work/boot.itb" "$work/$name.itb"
    echo "FIT_DIRTY_SYSTEM_RETAINED_READ_PASS: $name"
done
# A journal-committed candidate can be absent before checkpoint; the retained
# kernel must remain readable. Record this separately from successful selection.
timeout -k 5 60 docker run --rm --label ai-agent=true --network traefik \
    -v "$work:/w" ai-agent/mica-uboot-sandbox -D -c \
    "host bind disk /w/cut-published.img; if ext4load host 0:0 1000000 /kernels/$candidate/boot.itb; then host save hostfs - 1000000 /w/candidate.itb \${filesize}; else echo FIT_CANDIDATE_REQUIRES_FALLBACK; fi" \
    > "$work/candidate.log" 2>&1
if [ -f "$work/candidate.itb" ]; then
    cmp "$work/boot.itb" "$work/candidate.itb"
    echo 'FIT_DIRTY_SYSTEM_CANDIDATE_READ_PASS'
else
    grep -q FIT_CANDIDATE_REQUIRES_FALLBACK "$work/candidate.log"
    echo 'FIT_DIRTY_SYSTEM_CANDIDATE_REQUIRES_FALLBACK'
fi
