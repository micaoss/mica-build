#!/bin/bash
# mica-build-side: container -- a confirmed deployment can fail a later health gate.
set -euo pipefail
cd /w
arch=${1:?amd64 or arm64 required}
output=updates/5/confirmed-health
mkdir "$output"
cp --reflink=auto --sparse=always image/disk.img "$output/disk.img"
current=$(python3 -c 'import json; print(json.load(open("updates/5/inputs.json"))["id"])')
fallback=$(python3 -c 'import json; print(json.load(open("updates/4/inputs.json"))["id"])')
mren -i "$output/disk.img@@1M" "::/loader/entries/mica-$current+3.conf" "mica-$current.conf"
bash /harness/boot.sh "$output/disk.img" writable 300 "$arch" > "$output/refused.log" 2>&1
grep -q "mica-init: verified deployment $current" "$output/refused.log"
! grep -q FILE_AB_RUNTIME_PASS "$output/refused.log"
mdir -i "$output/disk.img@@1M" -b ::/loader/entries > "$output/entries.txt"
grep -q "mica-$current+0-3.conf" "$output/entries.txt"
bash /harness/boot.sh "$output/disk.img" writable 300 "$arch" > "$output/fallback.log" 2>&1
grep -q FILE_AB_RUNTIME_PASS "$output/fallback.log"
grep -q "\"deploymentId\":\"$fallback\"" "$output/fallback.log"
echo 'FILE_AB_CONFIRMED_HEALTH_FALLBACK_PASS'
