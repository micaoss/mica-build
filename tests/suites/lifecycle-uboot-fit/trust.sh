#!/bin/bash
# mica-build-side: container -- required FIT keys during explicit overlap/removal.
set -euo pipefail
cd /w
mkdir next-key
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj /CN=MICA-FIT-rotation \
    -keyout next-key/mica.key -out next-key/mica.crt > keygen.log 2>&1
cp /kernel/boot.itb next.itb
mkimage -F -k next-key -r next.itb > signing.log 2>&1
cat /old.crt next-key/mica.crt > overlap.pem
bash /source/embed-fit-trust.sh /firmware/u-boot.dtb overlap.pem overlap.dtb /usr/local/bin
bash /source/embed-fit-trust.sh /firmware/u-boot.dtb next-key/mica.crt next.dtb /usr/local/bin
test "$(fdtget overlap.dtb /signature required-mode)" = any
test "$(fdtget -l overlap.dtb /signature | wc -l)" = 2
test "$(fdtget -l next.dtb /signature | wc -l)" = 1
for fit in /kernel/boot.itb next.itb; do
    fit_check_sign -f "$fit" -k overlap.dtb > verify.log 2>&1
    grep -q 'Signature check OK' verify.log
done
fit_check_sign -f next.itb -k next.dtb > verify.log 2>&1
if fit_check_sign -f /kernel/boot.itb -k next.dtb > removed.log 2>&1; then
    echo 'error: removed FIT key was accepted' >&2; exit 1
fi
grep -q 'Signature check bad' removed.log
cp next.itb unsigned.itb
fdtput -r unsigned.itb /configurations/conf/signature
if fit_check_sign -f unsigned.itb -k overlap.dtb > unsigned.log 2>&1; then
    echo 'error: overlap accepted an unsigned FIT' >&2; exit 1
fi
cat next-key/mica.crt next-key/mica.crt > duplicate.pem
if bash /source/embed-fit-trust.sh /firmware/u-boot.dtb duplicate.pem duplicate.dtb /usr/local/bin > duplicate.log 2>&1; then
    echo 'error: duplicate boot keys were accepted' >&2; exit 1
fi
grep -q 'duplicate public boot key' duplicate.log
echo FIT_BOOT_TRUST_OVERLAP_REMOVAL_PASS
