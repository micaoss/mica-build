#!/bin/bash
# Start from a fresh complete runtime image and exercise real component updates.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?full runtime evidence directory required}
certificate=${2:?public content certificate required}
key=${3:?external content key required}
runkit=${4:?compiled mica-runkit required}
board=${5:?board required}
# The board's facts, out of its fetched bundle: the suite boots UEFI boards
# of either architecture and dispatches on nothing else.
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
case "$arch" in amd64) firmware=BOOTX64.EFI;; arm64) firmware=BOOTAA64.EFI;; esac
test -f "$evidence/image/factory-disk.img"
test ! -e "$evidence/updates"
boot() {
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 300 "$arch" >"$1" 2>&1
}
firmware_digest() {
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w:ro" \
        ai-agent/mica-p2-lab bash -ceu 'mcopy -i /w/image/disk.img@@1M "::/EFI/BOOT/$1" /tmp/firmware.efi; sha256sum /tmp/firmware.efi' _ "$firmware"
}
firmware_digest >"$evidence/firmware-before.txt"
root="$evidence/root"
kernel="$evidence/kernel"
for spec in '3 root' '4 kernel' '5 bad-health' '6 combined'; do
    read -r generation kind <<<"$spec"
    timeout 360s bun tests/suites/lifecycle-uefi/update.ts "$evidence" "$certificate" "$key" "$generation" "$kind" "$root" "$kernel" "$runkit"
    output="$evidence/updates/$generation"
    boot "$output/install.log"
    grep -F FILE_AB_INSTALL_PASS "$output/install.log"
    if [ "$kind" = bad-health ]; then
        mv "$evidence/offline" "$output/installed-media"
        timeout 660 docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
            -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
            bash /harness/confirmed-health.sh "$arch"
        for attempt in 1 2 3; do
            boot "$output/attempt-$attempt.log"
            grep -F 'mica-init: verified deployment' "$output/attempt-$attempt.log"
            ! grep -F FILE_AB_RUNTIME_PASS "$output/attempt-$attempt.log"
        done
        boot "$output/fallback.log"
        grep -F FILE_AB_RUNTIME_PASS "$output/fallback.log"
    else
        boot "$output/boot.log"
        grep -F FILE_AB_UPDATE_BOOT_PASS "$output/boot.log"
        grep -F FILE_AB_RUNTIME_PASS "$output/boot.log"
        if [ "$kind" != kernel ]; then root="$output/root"; fi
        if [ "$kind" != root ]; then kernel="$output/kernel"; fi
    fi
done
# The last generation's media leaves the evidence root: every later boot of a
# fresh factory disk (faults.sh) would import and install it.
mv "$evidence/offline" "$output/installed-media"
firmware_digest >"$evidence/firmware-after.txt"
cmp "$evidence/firmware-before.txt" "$evidence/firmware-after.txt"
python3 - "$evidence" <<'PY'
import json, pathlib, sys
p=pathlib.Path(sys.argv[1])
def record(g): return json.loads((p/f'updates/{g}/inputs.json').read_text())
def component(directory, name): return json.loads((pathlib.Path(directory)/f'{name}.json').read_text())['id']
assert component(record(3)['kernelDirectory'],'kernel')==component(p/'kernel','kernel')
assert component(record(4)['rootDirectory'],'rootfs')==component(record(3)['rootDirectory'],'rootfs')
assert component(record(6)['rootDirectory'],'rootfs')!=component(record(4)['rootDirectory'],'rootfs')
assert component(record(6)['kernelDirectory'],'kernel')!=component(record(4)['kernelDirectory'],'kernel')
for line in (p/'updates/5/fallback.log').read_text().splitlines():
    if '{"boot":' in line:
        status=json.loads(line[line.index('{"boot":'):]); break
else: raise AssertionError('No fallback status')
assert status['boot']['deploymentId']==record(4)['id'], status
assert status['state']['current']==record(4)['id'] and status['state']['candidate'] is None, status
assert record(5)['id'] in status['state']['failed'] and status['state']['highestGeneration']==5, status
assert all(d['id']!=record(5)['id'] for d in status['deployments']), status
print('FILE_AB_UPDATE_SEQUENCE_PASS')
PY
