#!/bin/bash
# Independent loader replacement, recovery, and boot-key removal after rotation.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
evidence=${1:?completed trust-rotation evidence required}
board=${2:?board required}
# The board's facts, out of its fetched bundle: the suite boots UEFI boards
# of either architecture and dispatches on nothing else.
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test -f "$evidence/updates/6/fallback.log"
test ! -d "$evidence/loader-replacement"
bun_image=$(bash tools/from.sh --ref mica-build-env:base)
docker build --label ai-agent=true -t ai-agent/mica-firmware-lab \
    --build-arg "MICA_BUN_IMAGE=$bun_image" --build-arg MICA_LAB_IMAGE=ai-agent/mica-p2-lab \
    -f tests/suites/lifecycle-uefi/Dockerfile.maintenance tests/suites/lifecycle-uefi
maintain() {
    timeout -k 10 300 docker run --rm --privileged --label ai-agent=true --network traefik \
        -v "$PWD:/src:ro" -v "$evidence:/w" ai-agent/mica-firmware-lab \
        bash /src/tests/suites/lifecycle-uefi/firmware-mounted.sh "$@" "$board"
}
boot() {
    timeout -k 10 350 docker run --rm --label ai-agent=true --network traefik \
        -v "$evidence:/w" -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh "$1" writable "${3:-300}" "$arch" > "$2" 2>&1
}
maintain /w/image/disk.img /w/firmware-next /w/firmware/firmware.json /w/loader-replacement
boot image/disk.img "$evidence/loader-replaced.log"
grep -F FILE_AB_RUNTIME_PASS "$evidence/loader-replaced.log"
maintain /w/image/disk.img /w/loader-replacement /w/firmware-next/firmware.json /w/loader-restoration
boot image/disk.img "$evidence/loader-restored.log"
grep -F FILE_AB_RUNTIME_PASS "$evidence/loader-restored.log"
maintain /w/image/disk.img /w/firmware-next /w/firmware/firmware.json /w/loader-final
cp "$evidence/vars.fd" "$evidence/vars-overlap.fd"
docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" ai-agent/mica-p2-lab \
    virt-fw-vars --input /usr/share/OVMF/OVMF_VARS_4M.fd --output /w/vars.fd \
    --set-pk 6b62601e-3448-4418-8923-7c9fa22ab09b /w/db-next.cert.pem \
    --add-kek 6b62601e-3448-4418-8923-7c9fa22ab09b /w/db-next.cert.pem \
    --add-db 6b62601e-3448-4418-8923-7c9fa22ab09b /w/db-next.cert.pem --no-microsoft --sb
boot image/disk.img "$evidence/new-boot-key-only.log"
grep -F FILE_AB_RUNTIME_PASS "$evidence/new-boot-key-only.log"
cp --reflink=auto --sparse=always "$evidence/image/disk.img" "$evidence/image/old-loader.img"
maintain /w/image/old-loader.img /w/loader-replacement /w/firmware-next/firmware.json /w/removed-key-recovery
result=0
boot image/old-loader.img "$evidence/removed-boot-key.log" 60 || result=$?
test "$result" = 124
! grep -F 'mica-init:' "$evidence/removed-boot-key.log"
grep -Ei 'Security Violation|Access Denied|Image failed to load' "$evidence/removed-boot-key.log"
cp --reflink=auto --sparse=always "$evidence/image/disk.img" "$evidence/image/retained-key.img"
id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["id"])' "$evidence/updates/5/inputs.json")
docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" ai-agent/mica-p2-lab \
    mren -i /w/image/retained-key.img@@1M "::/loader/entries/mica-$id.conf" "mica-$id+0-3.conf"
boot image/retained-key.img "$evidence/retained-boot-key.log"
grep -F FILE_AB_RUNTIME_PASS "$evidence/retained-boot-key.log"
python3 - "$evidence" <<'PY'
import json,pathlib,sys
p=pathlib.Path(sys.argv[1]); expected=json.loads((p/'updates/4/inputs.json').read_text())['id']
for line in (p/'retained-boot-key.log').read_text().splitlines():
    if '{"boot":' in line:
        receipt=json.loads(line[line.index('{"boot":'):])['boot']; break
else: raise AssertionError('missing retained boot receipt')
assert receipt['deploymentId']==expected and receipt['secureBoot']
print('UEFI_FIRMWARE_REPLACEMENT_RECOVERY_KEY_REMOVAL_PASS')
PY
