#!/bin/bash
# mica-build-side: container -- inject faults into fresh copies of the full image.
set -euo pipefail
cd /w
arch=${1:?amd64 or arm64 required}
case "$arch" in amd64|arm64) ;; *) exit 1;; esac
mkdir faults
cp --reflink=auto --sparse=always image/factory-disk.img faults/readonly.img
set +e
bash /lab/boot.sh faults/readonly.img readonly 25 "$arch" > faults/readonly.log 2>&1
rc=$?
set -e
test "$rc" = 0 || test "$rc" = 124
grep -q 'Mica OS: attempt state was not persisted; refusing boot' faults/readonly.log
! grep -q 'Run /init as init process' faults/readonly.log
echo 'PASS: failed attempt persistence never launches the kernel'

cp --reflink=auto --sparse=always image/factory-disk.img faults/fallback.img
cp --reflink=auto --sparse=always image/system.img faults/system.img
python3 - <<'PY'
import base64, json, pathlib
records=json.loads(pathlib.Path('deployments.json').read_text())
record=records[1]
envelope=json.loads(record['envelope'])
signature=bytearray(base64.b64decode(envelope['signature']))
signature[0]^=1
envelope['signature']=base64.b64encode(signature).decode()
pathlib.Path('faults/invalid.json').write_text(json.dumps(envelope,separators=(',',':')))
pathlib.Path('faults/commands').write_text(f"rm /deployments/{record['id']}.json\nwrite /w/faults/invalid.json /deployments/{record['id']}.json\n")
pathlib.Path('faults/current-id').write_text(record['id'])
pathlib.Path('faults/fallback-id').write_text(records[0]['id'])
PY
debugfs -w -f faults/commands faults/system.img > faults/debugfs.log 2>&1
dd if=faults/system.img of=faults/fallback.img bs=1M seek=513 conv=notrunc,sparse status=none
for attempt in 1 2 3; do
    bash /lab/boot.sh faults/fallback.img writable 40 "$arch" > "faults/attempt-$attempt.log" 2>&1
    grep -q 'metadata signature rejected' "faults/attempt-$attempt.log"
    ! grep -q 'support mounted before system init' "faults/attempt-$attempt.log"
done
bash /lab/boot.sh faults/fallback.img writable 230 "$arch" > faults/fallback.log 2>&1
grep -q 'FILE_AB_RUNTIME_PASS' faults/fallback.log
grep -q "\"deploymentId\":\"$(cat faults/fallback-id)\"" faults/fallback.log
mdir -i faults/fallback.img@@1M -b ::/loader/entries > faults/entries.txt
! grep -q "mica-$(cat faults/current-id)" faults/entries.txt
echo 'PASS: three rejected descriptors select and confirm the retained fallback'

mren -i faults/fallback.img@@1M "::/loader/entries/mica-$(cat faults/fallback-id).conf" "mica-$(cat faults/fallback-id)+0-3.conf"
set +e
bash /lab/boot.sh faults/fallback.img writable 25 "$arch" > faults/exhausted.log 2>&1
rc=$?
set -e
test "$rc" = 0 || test "$rc" = 124
grep -q 'Mica OS: deployment attempts exhausted; recovery required' faults/exhausted.log
! grep -q 'Run /init as init process' faults/exhausted.log
echo 'PASS: exhausted deployments stop without refilling attempts'

cp --reflink=auto --sparse=always image/factory-disk.img faults/shared-system.img
# Destroy only SYSTEM's primary superblock magic in this disposable disk copy.
printf '\000\000' | dd of=faults/shared-system.img bs=1 seek=$((513 * 1048576 + 1024 + 56)) conv=notrunc status=none
bash /lab/boot.sh faults/shared-system.img writable 60 "$arch" > faults/shared-system.log 2>&1
grep -q 'shared SYSTEM unavailable; full-image reflash recovery required' faults/shared-system.log
grep -q 'Power down' faults/shared-system.log
! grep -q 'Restarting system' faults/shared-system.log
echo 'PASS: shared SYSTEM damage powers off for reflash without retry churn'

cp --reflink=auto --sparse=always image/factory-disk.img faults/shared-data.img
printf '\000\000' | dd of=faults/shared-data.img bs=1 seek=$((1537 * 1048576 + 1024 + 56)) conv=notrunc status=none
bash /lab/boot.sh faults/shared-data.img writable 60 "$arch" > faults/shared-data.log 2>&1
grep -q 'shared DATA metadata unavailable; recovery required' faults/shared-data.log
grep -q 'Power down' faults/shared-data.log
! grep -q 'Restarting system' faults/shared-data.log
echo 'PASS: shared DATA damage powers off before starting system init'
