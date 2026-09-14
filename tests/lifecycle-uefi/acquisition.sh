#!/usr/bin/env bash
# Exercise production archive import and HTTP acquisition on a fresh full image.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
evidence=${1:?full runtime evidence required}
certificate=${2:?content certificate required}
key=${3:?content key required}
runkit=${4:?mica-runkit required}
board=${5:?board required}
origin=${6:?running update server origin required}
token=${7:?admin token file required}
# The board's facts, out of its fetched bundle: the suite boots UEFI boards
# of either architecture and dispatches on nothing else.
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test -f "$evidence/image/factory-disk.img"
test ! -e "$evidence/updates"
boot() {
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 420 "$arch" >"$1" 2>&1
    grep -F FILE_AB_RUNTIME_PASS "$1"
    bash tests/lifecycle-uefi/shutdown-check.sh "$1"
}
root="$evidence/root"
kernel="$evidence/kernel"
for spec in '3 root' '4 kernel'; do
    read -r generation kind <<<"$spec"
    timeout 360s bun tests/lifecycle-uefi/update.ts "$evidence" "$certificate" "$key" "$generation" "$kind" "$root" "$kernel" "$runkit"
    output="$evidence/updates/$generation"
    mv "$evidence/offline" "$output/raw-media"
    mkdir "$evidence/offline"
    cp "$output/raw-media/expected-id" "$evidence/offline/expected-id"
    if [ "${FILE_AB_INJECT_DATA_WRITE_FAILURE:-0}" = 1 ]; then
        touch "$evidence/offline/recover-data-write"
    fi
    if [ "$kind" = root ]; then
        root="$output/root"
        timeout 120s bash build/run.sh --components archive \
            --input "$output/offline/deployment.json" --kernel "$kernel" --root "$root" \
            --public-key "$(cat "$evidence/metadata.pub")" --out "$evidence/offline/update.micaupd"
    else
        timeout 300s bun tests/lifecycle-uefi/publish.ts "$evidence" "$generation" "$origin" "$token"
    fi
    boot "$output/install.log"
    grep -F FILE_AB_INSTALL_PASS "$output/install.log"
    if [ "${FILE_AB_INJECT_DATA_WRITE_FAILURE:-0}" = 1 ]; then
        grep -F FILE_AB_RETIREMENT_RECOVERY_PASS "$output/install.log"
    fi
    boot "$output/boot.log"
    grep -F FILE_AB_UPDATE_BOOT_PASS "$output/boot.log"
done
echo FILE_AB_ACQUISITION_PASS
