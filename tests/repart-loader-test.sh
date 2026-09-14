#!/bin/bash
# Exercise the current factory image's DATA growth policy with real systemd-repart.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
board=${1:?board required}
image=$(realpath "${2:?complete factory image required}")
root_image=$(realpath "${3:?matching composed root image required}")
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ -f "$image" ] && [ -f "$root_image" ]
command -v docker >/dev/null
. "_out/boards/$board/board.env"
[ "$LAYOUT_VERSION" = 3 ] && [ "$DATA_PARTNUM" = 3 ]
work=$(mktemp -d "$PWD/_out/data-growth.XXXXXX")
printf 'Evidence: %s\n' "$work"
cp --reflink=auto --sparse=always "$image" "$work/disk.img"
truncate -s 8G "$work/disk.img"
timeout -k 10 600 bash tests/signed-boot-lab/images.sh --lifecycle > "$work/tools.log" 2>&1
timeout -k 10 240 docker run --rm --label ai-agent=true --network traefik --privileged \
    -v "$work:/w" -v "$root_image:/rootfs.img:ro" -v "$PWD/tests/repart:/harness:ro" \
    -e SYSTEM_UUID="${SYSTEM_GUID,,}" -e DISK_UUID="${DISK_GUID,,}" \
    ai-agent/mica-p2-lab bash /harness/inner.sh
