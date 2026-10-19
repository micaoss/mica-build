#!/bin/bash
# mica-build-side: container -- every command below runs inside the lab image;
#   ukify, sbsign, mkfs.vfat, mcopy, sgdisk and qemu are that image's.
#
# Inside the lab container: build one signed UKI, two Type #1 entries that
# share it, enrol development Secure Boot keys into a disposable variable
# store, and boot the result five times.
#
#   uefi-inner.sh <kernel-file> <efi-arch> <stub> <boot-name> <qemu-binary>
set -euo pipefail
KERNEL="$1"; EFIARCH="$2"; STUB="$3"; BOOTNAME="$4"; QEMU="$5"
W=/w/uefi; rm -rf "${W}"; mkdir -p "${W}"; cd "${W}"
GUID="$(cat /proc/sys/kernel/random/uuid)"

echo "== 1. development Secure Boot keys (disposable, this run only)"
for k in PK KEK db; do
    openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 \
        -subj "/O=mica development/CN=mica development ${k}" \
        -keyout "${k}.key" -out "${k}.crt" 2>/dev/null
done

echo "== 2. the initrd inside the UKI: busybox and one script"
rm -rf ir; mkdir -p ir/bin ir/proc ir/sys ir/dev
# The guest is the TARGET architecture and this container is amd64, so an
# aa64 run cannot take the busybox beside it. The arm64 package comes from the
# same pinned snapshot the image was built from.
if [ "${EFIARCH}" = aa64 ]; then
    rm -rf bb; mkdir -p bb
    ( cd bb && apt-get update -qq >/dev/null 2>&1 && \
      apt-get download busybox-static:arm64 >/dev/null 2>&1 && \
      dpkg-deb -x busybox-static*.deb . )
    # usr/bin, not bin: the .deb is merged-usr and carries no /bin symlink of
    # its own, so an extracted tree has the binary under usr/ only.
    cp bb/usr/bin/busybox ir/bin/busybox
else
    cp /bin/busybox ir/bin/busybox
fi
file ir/bin/busybox | sed 's/^/    busybox: /'
cat > ir/init <<'INIT'
#!/bin/busybox sh
/bin/busybox mkdir -p /sys/firmware/efi/efivars
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t efivarfs efivarfs /sys/firmware/efi/efivars 2>/dev/null
E=/sys/firmware/efi/efivars
V=4a67b082-0a4c-41cf-b6c7-440b29bb8c4f
echo "PROOF uefi cmdline $(/bin/busybox cat /proc/cmdline)"
for v in LoaderEntrySelected LoaderEntryDefault LoaderEntryOneShot LoaderFirmwareInfo LoaderDevicePartUUID LoaderImageIdentifier; do
    f="${E}/${v}-${V}"
    if [ -e "${f}" ]; then
        echo "PROOF uefi ${v}=$(/bin/busybox dd if="${f}" bs=1 skip=4 2>/dev/null | /bin/busybox tr -d '\000')"
    else
        echo "PROOF uefi ${v}=<absent>"
    fi
done
SB="${E}/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"
if [ -e "${SB}" ]; then
    echo "PROOF uefi SecureBoot=$(/bin/busybox dd if="${SB}" bs=1 skip=4 count=1 2>/dev/null | /bin/busybox od -An -tu1 | /bin/busybox tr -d ' \n')"
else
    echo "PROOF uefi SecureBoot=<absent>"
fi
echo "PROOF uefi stub-cmdline-source $(/bin/busybox grep -c mica.uki=k1 /proc/cmdline)"
echo "PROOF uefi END"
/bin/busybox sync
/bin/busybox poweroff -f
INIT
chmod +x ir/init
( cd ir && find . | cpio -o -H newc --quiet | gzip -9 > ../initrd.cpio.gz )
ls -la initrd.cpio.gz

echo "== 3. the UKI: one image, an embedded command line, signed with db"
ukify build --linux="${KERNEL}" --initrd=initrd.cpio.gz \
    --cmdline="console=ttyAMA0 console=ttyS0 mica.uki=k1 dm_verity.require_signatures=1 rdinit=/init" \
    --stub="${STUB}" --efi-arch="${EFIARCH}" --uname="mica-p1-proof" \
    --output=k1.efi \
    --signtool=sbsign --secureboot-private-key=db.key --secureboot-certificate=db.crt
sbverify --list k1.efi | sed 's/^/    uki: /'
sbsign --key db.key --cert db.crt --output "${BOOTNAME}" "${STUB%/*}/systemd-boot${EFIARCH}.efi"
sbverify --list "${BOOTNAME}" | sed 's/^/    boot: /'

echo "== 4. the ESP: one UKI outside EFI/Linux, two Type #1 entries that share it"
rm -f esp.img
truncate -s 512M esp.img
mkfs.vfat -F 32 -n MICAESP esp.img >/dev/null
mmd -i esp.img ::/EFI ::/EFI/BOOT ::/EFI/mica ::/EFI/mica/kernels ::/loader ::/loader/entries
mcopy -i esp.img "${BOOTNAME}" "::/EFI/BOOT/${BOOTNAME}"
mcopy -i esp.img k1.efi ::/EFI/mica/kernels/k1.efi
cat > loader.conf <<'CONF'
timeout 0
console-mode keep
auto-entries no
auto-firmware no
CONF
mcopy -i esp.img loader.conf ::/loader/loader.conf
cat > mica-depA+3.conf <<'CONF'
title    mica deployment A
version  2
sort-key mica
efi      /EFI/mica/kernels/k1.efi
options  mica.deployment=depA-from-entry-options
CONF
cat > mica-depB+3.conf <<'CONF'
title    mica deployment B
version  1
sort-key mica
efi      /EFI/mica/kernels/k1.efi
options  mica.deployment=depB-from-entry-options
CONF
mcopy -i esp.img mica-depA+3.conf ::/loader/entries/
mcopy -i esp.img mica-depB+3.conf ::/loader/entries/

echo "== 5. the disk: one GPT, one ESP at 1 MiB"
rm -f disk.img
truncate -s 544M disk.img
sgdisk --clear --new=1:2048:+512M --typecode=1:ef00 --change-name=1:ESP disk.img >/dev/null
dd if=esp.img of=disk.img bs=1M seek=1 conv=notrunc status=none
sgdisk --print disk.img | tail -3

echo "== 6. the variable store: PK/KEK/db enrolled, Secure Boot on"
if [ "${EFIARCH}" = aa64 ]; then
    cp /usr/share/AAVMF/AAVMF_VARS.fd vars.fd
else
    cp /usr/share/OVMF/OVMF_VARS_4M.fd vars.fd
fi
virt-fw-vars --input vars.fd --output vars.enrolled.fd \
    --set-pk "${GUID}" PK.crt --add-kek "${GUID}" KEK.crt --add-db "${GUID}" db.crt \
    --no-microsoft --sb >/dev/null
mv vars.enrolled.fd vars.fd
virt-fw-vars --input vars.fd --print 2>&1 | grep -iE 'SecureBoot|PK|KEK|db' | head -10 || true

if [ "${EFIARCH}" = aa64 ]; then
    CODE=/usr/share/AAVMF/AAVMF_CODE.secboot.fd; MACHINE=virt
else
    CODE=/usr/share/OVMF/OVMF_CODE_4M.secboot.fd; MACHINE=q35
fi
cp "${CODE}" code.fd

# THE DISK, NOT esp.img. The firmware boots disk.img and systemd-boot renames
# the counting entries inside it; esp.img is the image those bytes were copied
# FROM before the first boot, so listing it shows the pre-boot state on every
# run -- measured: four boots, `mica-depA+3.conf` unchanged, while the machine
# had plainly moved on to the second entry.
ESP="disk.img@@1M"
esp_entries() { mdir -i "${ESP}" -b ::/loader/entries | sed 's/^/    entry: /'; }

boot() {   # boot <label> <seconds>
    echo "== boot ${1}"
    esp_entries
    timeout "${2}" "${QEMU}" -machine "${MACHINE}" -cpu max -m 2048 -smp 2 \
        -nographic -no-reboot \
        -drive if=pflash,format=raw,unit=0,readonly=on,file=code.fd \
        -drive if=pflash,format=raw,unit=1,format=raw,file=vars.fd \
        -drive if=none,id=disk0,format=raw,file=disk.img \
        -device virtio-blk-pci,drive=disk0,bootindex=0 2>&1 | sed "s/^/[${1}] /" || echo "[${1}] (qemu exit $?)"
    echo "== after ${1}"
    esp_entries
}

boot try1 180
boot try2 180
boot try3 180
boot try4 180

echo "== 7. the same UKI with one byte changed, under the same enrolled keys"
mcopy -n -i "${ESP}" ::/EFI/mica/kernels/k1.efi k1.readback.efi
cmp -s k1.efi k1.readback.efi && echo "    readback identical" || echo "    readback DIFFERS"
python3 - <<'PY'
import pathlib
p = pathlib.Path("k1.readback.efi")
b = bytearray(p.read_bytes())
off = len(b) // 2
b[off] ^= 0x01
p.write_bytes(bytes(b))
print(f"    flipped one bit at offset {off} of {len(b)}")
PY
mcopy -o -n -i "${ESP}" k1.readback.efi ::/EFI/mica/kernels/k1.efi
# Both entries have spent their tries by now, so give each a fresh counter --
# otherwise "no entry left" would be the reason nothing boots and the modified
# image would never be presented to the firmware at all.
for f in $(mdir -i "${ESP}" -b ::/loader/entries || true); do
    case "${f}" in *mica-dep*) mdel -i "${ESP}" "${f}" || true ;; esac
done
mcopy -o -i "${ESP}" mica-depA+3.conf ::/loader/entries/mica-depA+3.conf
mcopy -o -i "${ESP}" mica-depB+3.conf ::/loader/entries/mica-depB+3.conf
boot modified-uki 180
echo "== DONE"
