#!/bin/bash
# Exercise the current factory image's DATA growth policy with real systemd-repart.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
board=${1:?board required}
image=$(realpath "${2:?complete factory image required}")
root_image=$(realpath "${3:?matching composed root image required}")
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ -f "$image" ] && [ -f "$root_image" ]
command -v docker >/dev/null
layout="_out/boards/$board/layout.tsv"
[ "$(head -n 1 "$layout")" = '# mica layout v1' ]
# The data partition is the last, which growth extends; its guid and the system's and disk's out of layout.tsv.
DATA_PARTNUM=$(awk -F'\t' '$1 == "part" && $4 == "data" { print $2 }' "$layout")
SYSTEM_GUID=$(awk -F'\t' '$1 == "part" && $4 == "system" { print $8 }' "$layout")
DISK_GUID=$(awk -F'\t' '$1 == "disk" { print $2 }' "$layout")
[ "$DATA_PARTNUM" = "$(awk -F'\t' '$1 == "part"' "$layout" | wc -l)" ] && [ -n "$SYSTEM_GUID" ] && [ -n "$DISK_GUID" ]
work=$(mktemp -d "$PWD/_out/data-growth.XXXXXX")
printf 'Evidence: %s\n' "$work"
cp --reflink=auto --sparse=always "$image" "$work/disk.img"
truncate -s 8G "$work/disk.img"
timeout -k 10 600 bash tests/suites/signed-boot-lab/images.sh --lifecycle > "$work/tools.log" 2>&1
timeout -k 10 240 docker run --rm --label ai-agent=true --network traefik --privileged \
    -v "$work:/w" -v "$root_image:/rootfs.img:ro" -v "$PWD/tests/suites/repart:/harness:ro" \
    -e SYSTEM_UUID="${SYSTEM_GUID,,}" -e DISK_UUID="${DISK_GUID,,}" \
    ai-agent/mica-p2-lab bash /harness/inner.sh
