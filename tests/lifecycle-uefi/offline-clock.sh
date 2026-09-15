#!/bin/bash
# Boot the installed HTTP deployment with an expired catalog and no network.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source=$(realpath "${1:?completed HTTP runtime evidence required}")
catalog=$(realpath "${2:?captured catalog envelope required}")
board=${3:?board required}
# The board's facts, out of its fetched bundle: the suite boots UEFI boards
# of either architecture and dispatches on nothing else.
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test -s "$source/updates/6/http-measurements.json"
expected=$(python3 - "$source/updates/6/inputs.json" <<'PY'
import json,sys
print(json.load(open(sys.argv[1]))['id'])
PY
)
grep -F "FILE_AB_UPDATE_BOOT_PASS: $expected" "$source/updates/6/boot.log"
work=$(mktemp -d "$PWD/_out/offline-clock.XXXXXX")
cp "$catalog" "$work/catalog.json"
python3 - "$catalog" "$work/catalog-time.json" <<'PY'
import base64,datetime,json,sys
envelope=json.load(open(sys.argv[1])); value=json.loads(base64.b64decode(envelope['payload'],validate=True))
assert value['schema']=='mica/catalog/v2'
issued=datetime.datetime.fromisoformat(value['issuedAt'].replace('Z','+00:00'))
expires=datetime.datetime.fromisoformat(value['expiresAt'].replace('Z','+00:00'))
assert datetime.datetime(1970,1,1,tzinfo=datetime.timezone.utc)<issued<expires<datetime.datetime(2040,1,1,tzinfo=datetime.timezone.utc)
with open(sys.argv[2],'w') as f:json.dump({'issuedAt':value['issuedAt'],'expiresAt':value['expiresAt'],'network':'none'},f)
PY
for rtc in 2040-01-01T00:00:00 1970-01-01T00:00:00; do
    out="$work/${rtc%%T*}"
    mkdir "$out"
    cp --reflink=auto --sparse=always "$source/image/disk.img" "$out/disk.img"
    cp "$source/db.cert.pem" "$out/db.cert.pem"
    python3 - "$out/boot.sh" "$rtc" <<'PY'
from pathlib import Path
import sys
s=Path('tests/lifecycle-uefi/boot.sh').read_text()
network='-netdev user,id=net0 -device virtio-net-pci,netdev=net0'
assert s.count(network)==1
s=s.replace(network, '-nic none -rtc base='+sys.argv[2]+',clock=vm')
Path(sys.argv[1]).write_text(s)
PY
    timeout -k 15 600 docker run --rm --label ai-agent=true --network traefik \
        -v "$out:/w" ai-agent/mica-p2-lab bash /w/boot.sh disk.img writable 540 "$arch" > "$out/boot.log" 2>&1
    grep -F "mica-init: verified deployment $expected;" "$out/boot.log"
    grep -F FILE_AB_RUNTIME_PASS "$out/boot.log"
    bash tests/lifecycle-uefi/shutdown-check.sh "$out/boot.log"
    echo "FILE_AB_OFFLINE_CLOCK_PASS: $board $rtc"
done
printf 'Evidence: %s\n' "$work"
