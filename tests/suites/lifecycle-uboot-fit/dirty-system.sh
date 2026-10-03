#!/bin/bash
# mica-build-side: container -- snapshot exact SYSTEM features with loop/dm privileges.
set -euo pipefail
cd /w
cp --reflink=auto --sparse=always system.img live.img
mkdir mount
device=$(losetup --find --show /w/live.img)
mapping="mica-file-ab-$(cat /proc/sys/kernel/random/uuid)"
export MICA_TEST_MAPPING="$mapping"
dmsetup create "$mapping" --table "0 $(blockdev --getsz "$device") linear $device 0"
cleanup() {
    dmsetup resume "$mapping" >/dev/null 2>&1 || true
    mountpoint -q /w/mount && umount /w/mount
    dmsetup remove "$mapping"
    losetup --detach "$device"
}
trap cleanup EXIT
dmsetup mknodes "$mapping"
mount -t ext4 -o rw,nodev,nosuid,noexec "/dev/mapper/$mapping" /w/mount
python3 - <<'PY'
from pathlib import Path
import os,struct,subprocess
root=Path('/w/mount'); current=Path('/w/kernel-id').read_text().strip()
candidate='f'*64
assert candidate!=current
source=root/'kernels'/current/'boot.itb'
pending=root/'staging'/candidate; pending.mkdir()
def directory(path):
    descriptor=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
    try: os.fsync(descriptor)
    finally: os.close(descriptor)
def snapshot(name):
    # Stop block IO without freezing/syncing ext4. Copying the backing file
    # then captures one stable disk state, including its unclean journal.
    mapping=os.environ['MICA_TEST_MAPPING']
    subprocess.run(['dmsetup','suspend','--noflush','--nolockfs',mapping],check=True,timeout=15)
    try:
        subprocess.run(['cp','--sparse=always','/w/live.img',f'/w/{name}.img'],check=True,timeout=60)
    finally:
        subprocess.run(['dmsetup','resume',mapping],check=True,timeout=15)
    with open(f'/w/{name}.img','rb') as image:
        image.seek(1024+96);flags=struct.unpack('<I',image.read(4))[0]
        assert flags&4, 'snapshot must require journal recovery'
        assert not flags&0x2000, 'unexpected metadata_csum_seed'
    print(f'FIT_DIRTY_SYSTEM_SNAPSHOT: {name}',flush=True)
with source.open('rb') as original,(pending/'boot.itb').open('xb') as output:
    output.write(original.read(1048576)); output.flush()
    snapshot('cut-partial')
    while chunk:=original.read(1048576): output.write(chunk)
    output.flush();os.fsync(output.fileno())
directory(pending);snapshot('cut-files')
os.rename(pending,root/'kernels'/candidate)
directory(root/'kernels');directory(root/'staging')
snapshot('cut-published')
Path('/w/candidate-id').write_text(candidate)
PY
echo 'FIT_DIRTY_SYSTEM_CAPTURE_PASS'
