#!/bin/bash
# mica-build-side: container -- authenticate against the actual shipped control FDT.
set -euo pipefail
cd /w
if [ -f /firmware/u-boot.bin.signed ]; then
    python3 - <<'PY_FIP'
from pathlib import Path
import struct
import subprocess
payload = Path('/firmware/u-boot.bin.signed').read_bytes()
offset = payload.find(b'ZSTD', 1703936)
assert offset >= 1703936
size, compressed = struct.unpack_from('<II', payload, offset + 4)
raw = subprocess.run(['zstd', '-d', '-c'], input=payload[offset + 12:offset + 12 + compressed], capture_output=True, check=True).stdout
control = Path('/firmware/u-boot.dtb').read_bytes()
assert len(raw) == size and control in raw
Path('embedded-control.dtb').write_bytes(control)
print('AMLOGIC_FIP_CONTROL_EMBEDDED_PASS')
PY_FIP
else
    dumpimage -T flat_dt -p 4 -o embedded-control.dtb /firmware/u-boot.itb > extract.log 2>&1
    cmp embedded-control.dtb /firmware/u-boot.dtb
fi
[ "$(fdtget embedded-control.dtb /signature required-mode)" = any ]
mapfile -t required_keys < <(fdtget -l embedded-control.dtb /signature)
[ "${#required_keys[@]}" -ge 1 ] && [ "${#required_keys[@]}" -le 8 ]
for key in "${required_keys[@]}"; do
    [ "$(fdtget embedded-control.dtb "/signature/$key" required)" = conf ]
done
if [ -f /firmware/u-boot-rockchip.bin ]; then
python3 - <<'PY'
from pathlib import Path
loader=Path('/firmware/u-boot-rockchip.bin').read_bytes()
fit=Path('/firmware/u-boot.itb').read_bytes()
assert len(loader)<=16744448 and loader.count(fit)==1
print('FIT_FIRMWARE_CONTROL_EMBEDDED_PASS')
PY
fi
fit_check_sign -f /kernel/boot.itb -k embedded-control.dtb > accepted.log 2>&1
grep -q 'Signature check OK' accepted.log
echo 'FIT_REQUIRED_SIGNATURE_PASS'
python3 - <<'PY'
from pathlib import Path
import struct
original=Path('/kernel/boot.itb').read_bytes()
header=struct.unpack('>10I',original[:40]); position=header[2]; strings=header[3]
path=[]; mutated=set()
while True:
    token=struct.unpack_from('>I',original,position)[0]; position+=4
    if token==1:
        end=original.index(0,position); path.append(original[position:end].decode()); position=(end+4)&~3
    elif token==2: path.pop()
    elif token==3:
        length,name=struct.unpack_from('>II',original,position); position+=8
        end=original.index(0,strings+name); name=original[strings+name:end].decode()
        node='/'.join(path)
        if node in ['/images/kernel','/images/fdt','/images/ramdisk'] and name=='data':
            data=bytearray(original); data[position+length//2]^=1
            name=node.rsplit('/',1)[-1]; Path(f'tampered-{name}.itb').write_bytes(data); mutated.add(name)
        position=(position+length+3)&~3
    elif token==4: pass
    elif token==9: break
    else: raise AssertionError(token)
assert mutated=={'kernel','fdt','ramdisk'}
PY
cp /kernel/boot.itb unsigned.itb
fdtput -r unsigned.itb /configurations/conf/signature
for image in tampered-kernel tampered-fdt tampered-ramdisk unsigned; do
    if fit_check_sign -f "$image.itb" -k embedded-control.dtb > "$image.log" 2>&1; then
        echo "error: accepted $image" >&2; exit 1
    fi
    grep -q 'Signature check bad' "$image.log"
done
mkdir /tmp/wrong-key
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=isolated-fit-negative \
    -keyout /tmp/wrong-key/mica.key -out /tmp/wrong-key/mica.crt > /tmp/keygen.log 2>&1
cp embedded-control.dtb wrong-key.dtb
fdtput -r wrong-key.dtb /signature
fdt_add_pubkey -a sha256,rsa2048 -k /tmp/wrong-key -n mica -r conf wrong-key.dtb > wrong-key-add.log 2>&1
if fit_check_sign -f /kernel/boot.itb -k wrong-key.dtb > wrong-key.log 2>&1; then
    echo 'error: accepted an unknown FIT key' >&2; exit 1
fi
grep -q 'Signature check bad' wrong-key.log
echo 'FIT_TAMPER_MISSING_UNKNOWN_KEY_PASS'
