#!/usr/bin/env bash
# Exercise full-image preflight, readback and reset ordering against a fake medium.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# Scratch under the repository's _out, not the board's: a board directory is data.
mkdir -p "$PWD/../../_out"
work=$(mktemp -d "$PWD/../../_out/cx-flash-check.XXXXXX")
trap 'rm -rf "$work"' EXIT
export RK_DEVICE="$work/medium" RK_LOG="$work/calls"
cat > "$work/rkdeveloptool" <<'STUB'
#!/bin/bash
set -euo pipefail
printf '%s\n' "$*" >> "$RK_LOG"
case "$1" in
wl)
    test "$2" = 0
    cp --reflink=auto --sparse=always "$3" "$RK_DEVICE"
    if [ -n "${RK_CORRUPT:-}" ]; then printf bad | dd of="$RK_DEVICE" bs=1 seek="$RK_CORRUPT" conv=notrunc status=none; fi
    ;;
rl) dd if="$RK_DEVICE" of="$4" bs=512 skip="$2" count="$3" conv=sparse status=none;;
rd) ;;
*) exit 9;;
esac
STUB
chmod +x "$work/rkdeveloptool"
python3 - "$work/image.img" <<'PY'
import pathlib, struct, sys, uuid, zlib
path=pathlib.Path(sys.argv[1]); size=1299*1048576; last=size//512-1
entries=bytearray(128*128)
for n,(name,first,end) in enumerate([('firmware',64,36863),('system',36864,2134015),('data',2134016,2658303)]):
 o=n*128
 entries[o:o+16]=uuid.UUID('8DA63339-0007-60C0-C436-083AC8230908' if n==0 else '0FC63DAF-8483-4772-8E79-3D69D8477DE4').bytes_le
 entries[o+16:o+32]=uuid.UUID(f'5AC35760-0002-4000-8000-00000000000{n+1}').bytes_le
 struct.pack_into('<QQ',entries,o+32,first,end)
 entries[o+56:o+56+len(name)*2]=name.encode('utf-16le')
def header(current,backup,table):
 h=bytearray(512);h[:8]=b'EFI PART'
 struct.pack_into('<IIIIQQQQ16sQIII',h,8,0x10000,92,0,0,current,backup,34,last-33,uuid.UUID('5AC35760-0002-4000-8000-000000000000').bytes_le,table,128,128,zlib.crc32(entries))
 struct.pack_into('<I',h,16,zlib.crc32(h[:92]));return h
with path.open('wb') as f:
 f.truncate(size);f.seek(510);f.write(b'\x55\xaa')
 f.seek(512);f.write(header(1,last,2));f.write(entries)
 f.seek(32768);f.write(b'RKNS')
 f.seek((last-32)*512);f.write(entries);f.write(header(last,1,last-32))
PY
run() {
    : > "$RK_LOG"
    make -s flash-mica RKDEVELOPTOOL="$work/rkdeveloptool" MICA_IMAGE="$1" > "$work/output" 2>&1
}
run "$work/image.img" || { cat "$work/output"; exit 1; }
[ "$(awk '{print $1}' "$RK_LOG" | tr '\n' ' ')" = 'wl rl rl rd ' ]
awk '$1=="rl" {print $2,$3}' "$RK_LOG" > "$work/ranges"
printf '0 36864\n36864 2623488\n' > "$work/expected"
cmp "$work/ranges" "$work/expected"
echo 'PASS: complete flash and both readbacks precede reset'
for offset in 32768 20971520 1093664768; do
    export RK_CORRUPT=$offset
    if run "$work/image.img"; then echo "FAIL: corrupt byte $offset accepted"; exit 1; fi
    ! grep -q '^rd$' "$RK_LOG"
    grep -Eq 'differs|mismatch' "$work/output"
    echo "PASS: corrupt byte $offset prevents reset"
done
unset RK_CORRUPT
printf bad > "$work/bad.img"
if run "$work/bad.img"; then echo 'FAIL: invalid image accepted'; exit 1; fi
test ! -s "$RK_LOG"
echo 'PASS: invalid image refuses before the first device command'
