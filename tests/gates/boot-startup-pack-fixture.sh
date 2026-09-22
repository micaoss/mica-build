#!/bin/bash
# mica-build-side: container -- bounded x64 kernel-ABI fixture, never a product image.
# /w is task-private; /src is the reviewed checkout. Reference tools are kept here.
set -euo pipefail
mode=${1:?transition, unsigned-guard, signed, or corrupt-data required}
case "$mode" in transition|unsigned-guard|untrusted|signed|corrupt-data) ;; *) exit 2 ;; esac
tree=/w/tree
mkdir -p "$tree"/{bin,sbin,data,dev,proc,sys,run,runkit}
cp /w/tools/busybox "$tree/bin/busybox"
cp /w/inputs/mica-runkit "$tree/runkit/init"
cp /w/inputs/fixture "$tree/fixture"
cp /src/tests/gates/boot-startup-guest-init.sh "$tree/init"
chmod 0755 "$tree/init"
for tool in veritysetup dmsetup; do
    source=$(command -v "$tool")
    bun /src/stages/boot/elf-closure.ts / "$tree" x64 "$source" "/sbin/$tool"
done
printf '%s\n' "$mode" > "$tree/case"
# Fixed data, explicit signed geometry, and no on-disk verity superblock.
head -c 8192 /dev/zero > "$tree/data/image"
truncate -s 12288 "$tree/data/image"
salt=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
veritysetup format "$tree/data/image" "$tree/data/image" --no-superblock --format 1 --hash sha256 \
    --data-block-size 4096 --hash-block-size 4096 --data-blocks 2 --hash-offset 8192 --salt "$salt" > /w/verity-format.log
awk '/^Root hash:/ {print $3}' /w/verity-format.log | tr -d '\n' > "$tree/data/roothash"
printf '%s' "$salt" > "$tree/data/salt"
image_hash=$(sha256sum "$tree/data/image"); image_hash=${image_hash%% *}
root=$(cat "$tree/data/roothash")
signature_hash=cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc
signature_bytes=1024
if [ "$mode" = untrusted ]; then
    cp /w/signatures/untrusted.p7s "$tree/data/"
fi
if [ "$mode" = signed ] || [ "$mode" = corrupt-data ]; then
    test -s /w/signatures/trusted.p7s
    cp /w/signatures/*.p7s "$tree/data/"
    signature_hash=$(sha256sum "$tree/data/trusted.p7s"); signature_hash=${signature_hash%% *}
    signature_bytes=$(stat -c%s "$tree/data/trusted.p7s")
fi
cat > "$tree/data/image.json" <<JSON
{"image":{"bytes":12288,"sha256":"$image_hash"},"rootHash":"$root","signature":{"bytes":$signature_bytes,"sha256":"$signature_hash"},"verity":{"version":1,"algorithm":"sha256","dataBlockSize":4096,"hashBlockSize":4096,"dataBlocks":2,"hashOffset":8192,"salt":"$salt"}}
JSON
if [ "$mode" = untrusted ]; then
    signature_hash=$(sha256sum "$tree/data/untrusted.p7s"); signature_hash=${signature_hash%% *}
    signature_bytes=$(stat -c%s "$tree/data/untrusted.p7s")
    sed -e "s/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc/$signature_hash/" \
        -e "s/\"bytes\":1024/\"bytes\":$signature_bytes/" "$tree/data/image.json" > "$tree/data/untrusted.json"
fi
if [ "$mode" = signed ] || [ "$mode" = corrupt-data ]; then
    python3 - "$tree/data" <<'PY'
import hashlib, json, pathlib, sys
p = pathlib.Path(sys.argv[1]); original = json.loads((p / 'image.json').read_text())
for case in ['corrupt', 'untrusted', 'wrong-root']:
    value = json.loads(json.dumps(original))
    if case == 'wrong-root':
        value['rootHash'] = 'e' * 64
    else:
        payload = (p / (case + '.p7s')).read_bytes()
        value['signature'] = dict(bytes=len(payload), sha256=hashlib.sha256(payload).hexdigest())
    (p / (case + '.json')).write_text(json.dumps(value))
PY
fi
if [ "$mode" = corrupt-data ]; then printf 'x' | dd of="$tree/data/image" bs=1 seek=0 conv=notrunc status=none; fi
printf '%s\n' 12345678-1234-4321-abcd-1234567890ab > "$tree/data/partuuid"
(
    cd "$tree"
    find . -exec touch -h -d @1577836800 {} +
    find . -print0 | LC_ALL=C sort -z | cpio --null --reproducible --owner=0:0 -o -H newc --quiet
) > "/w/$mode.cpio"
source /src/stages/boot/compression.sh
compress_payload "/w/$mode.cpio" "/w/$mode.cpio.zst" 67108864
sha256sum "$tree/bin/busybox" "$tree/sbin/veritysetup" "$tree/sbin/dmsetup" "$tree/runkit/init" "$tree/fixture" "/w/$mode.cpio" "/w/$mode.cpio.zst"
veritysetup --version
zstd --version
