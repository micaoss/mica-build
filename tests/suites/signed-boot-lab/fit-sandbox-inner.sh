#!/bin/bash
# mica-build-side: container -- every command below runs inside the U-Boot
#   sandbox image; mkimage and openssl here are that image's.
#
# Inside the U-Boot sandbox image: build a required-signature FIT over a
# kernel, a DTB and an initramfs, put the public key in the CONTROL FDT with
# `required = "conf"`, and drive U-Boot's own bootm over it -- valid, unsigned,
# wrong key, and one modified payload at a time.
set -euo pipefail
W=/w/fit; rm -rf "${W}"; mkdir -p "${W}/keys"; cd "${W}"

echo "== 1. two RSA-2048 FIT signing keys: one the control FDT will trust, one it will not"
for k in micadev other; do
    openssl genrsa -out "keys/${k}.key" 2048 2>/dev/null
    openssl req -batch -new -x509 -key "keys/${k}.key" -out "keys/${k}.crt" -days 3650 \
        -subj "/O=mica development/CN=mica development FIT ${k}" 2>/dev/null
done

echo "== 2. payloads: a slice of the real cx3576 kernel, the real DTB, an initramfs"
dd if="${KERNEL_IN}" of=kernel.bin bs=1M count=4 status=none
cp "${DTB_IN}" board.dtb
dd if=/dev/urandom of=initrd.img bs=1M count=1 status=none
ls -la kernel.bin board.dtb initrd.img

cp /lab/boot.its boot.its

echo "== 3. sign, and write the public key into the control FDT as REQUIRED for configurations"
cp /uboot/u-boot.dtb control.dtb
/uboot/tools/mkimage -f boot.its -k keys -K control.dtb -r boot.itb | sed 's/^/    /'
echo "    control FDT key node: $(fdtget -l control.dtb /signature 2>&1)"
echo "    required = $(fdtget control.dtb /signature/key-micadev required 2>&1)"
echo "    algo     = $(fdtget control.dtb /signature/key-micadev algo 2>&1)"

echo "== 4. the negatives, each built from the same .its"
/uboot/tools/mkimage -f boot.its unsigned.itb >/dev/null
sed 's/key-name-hint = "micadev"/key-name-hint = "other"/' boot.its > other.its
/uboot/tools/mkimage -f other.its -k keys other.itb >/dev/null
python3 - <<'PY'
import pathlib
itb = pathlib.Path("boot.itb").read_bytes()
def flip(name, needle, out):
    off = itb.find(needle)
    assert off >= 0, f"{name}: payload not found in the FIT"
    b = bytearray(itb)
    target = off + len(needle) + 64
    b[target] ^= 0x01
    pathlib.Path(out).write_bytes(bytes(b))
    print(f"    {name}: one bit flipped at {target} (payload starts at {off})")
flip("kernel",  pathlib.Path("kernel.bin").read_bytes()[:64],  "bad-kernel.itb")
flip("fdt",     pathlib.Path("board.dtb").read_bytes()[:64],   "bad-fdt.itb")
flip("ramdisk", pathlib.Path("initrd.img").read_bytes()[:64],  "bad-ramdisk.itb")
PY

run_case() {  # run_case <label> <itb>
    echo "== bootm ${1} (${2})"
    ( cd /uboot && timeout 30 ./u-boot -d "${W}/control.dtb" \
        -c "load hostfs - 0x1000000 ${W}/${2}; bootm 0x1000000" </dev/null 2>&1 ) \
        > "${W}/case-${1}.txt" || true
    # The verdict lines only. The full transcript stays beside them; a `head`
    # in this pipeline would SIGPIPE the reader and, under `set -o pipefail`,
    # end the run after the first case -- measured.
    sed 's/\x1b\[[0-9;]*m//g' "${W}/case-${1}.txt" \
        | grep -E 'Verifying Hash|Failed to verify|Bad |bad |signature|Could not find|ERROR|Ramdisk|No valid|Unsupported|not found|## ' \
        | grep -v 'device tree node' | sed "s/^/    [${1}] /" || echo "    [${1}] (no verdict line)"
}

run_case valid          boot.itb
run_case unsigned       unsigned.itb
run_case wrong-key      other.itb
run_case modified-kernel  bad-kernel.itb
run_case modified-fdt     bad-fdt.itb
run_case modified-ramdisk bad-ramdisk.itb
echo "== DONE"
