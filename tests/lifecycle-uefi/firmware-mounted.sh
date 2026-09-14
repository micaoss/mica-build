#!/bin/bash
# mica-build-side: container -- maintenance runs inside the privileged disposable lab image.
# Offline ESP maintenance inside the disposable privileged lab container.
set -euo pipefail
disk=${1:?disk file required}
input=${2:?firmware package required}
installed=${3:?installed signed receipt required}
recovery=${4:?fresh recovery directory required}
board=${5:?board required}
mkdir -p /w/esp
loop=$(losetup --find --show --offset 1048576 --sizelimit 536870912 "$disk")
mounted=0
cleanup() {
    if [ "$mounted" = 1 ]; then umount /w/esp; fi
    losetup -d "$loop"
}
trap cleanup EXIT
mount -t vfat "$loop" /w/esp
mounted=1
mapfile -t keys < <(python3 -c 'import json; print("\n".join(json.load(open("/w/public-keys.json"))))')
bun /src/build/src/component-cli.ts firmware-maintain --board "$board" --input "$input" \
    --installed "$installed" --out "$recovery" --esp /w/esp \
    --public-key "${keys[0]}" --public-key "${keys[1]}"
