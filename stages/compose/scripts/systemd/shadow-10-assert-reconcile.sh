#!/bin/sh
# The systemd half of the shadow chain: /var/lib/mica, where the reconciler's inputs live, is var-lib-mica.mount
# on STATE, and mica-shadow-reconcile.service is enabled and ordered before every reader of /etc/shadow.
#
# Called from stages/compose/90-pack.Dockerfile (pack stage) through init-steps.sh, after pack-assert-shadow-chain.sh.
set -eu
grep -qx 'Where=/var/lib/mica' /rootfs/etc/systemd/system/var-lib-mica.mount ||
    { echo "error: the /etc/shadow symlink target is not the Where= of var-lib-mica.mount, so it is not STATE-backed" >&2; exit 1; }
unit=/rootfs/etc/systemd/system/mica-shadow-reconcile.service
test -f "${unit}"
test -x /rootfs/usr/lib/mica/mica-shadow-reconcile
test -L /rootfs/etc/systemd/system/multi-user.target.wants/mica-shadow-reconcile.service ||
    { echo "error: mica-shadow-reconcile.service is installed but not enabled; /etc/shadow would never converge with the image accounts" >&2; exit 1; }
# ORDERED BEFORE EVERY READER, not after a mount. The reconciler used to
# require var-lib-mica.mount because the shadow file lived on STATE; it now
# builds the file in /run, which systemd has already mounted, so there is
# no storage dependency left to order against.
#
# What must be asserted instead is that nothing reads /etc/shadow before it
# exists. If this ordering is lost the failure is not a wrong password --
# it is PAM finding no shadow file at all, which fails closed for every
# account including the transient root the operator is trying to use.
for reader in micad.service dropbear.service systemd-logind.service; do
    grep -qE "^Before=.*\\b${reader}\\b" "${unit}" ||
        { echo "error: mica-shadow-reconcile.service does not order Before=${reader}; that reader would find no /etc/shadow at all, because the file is built in RAM by this unit" >&2; exit 1; }
done
if grep -qE '^After=.*var-lib-mica' "${unit}"; then
    echo "error: mica-shadow-reconcile.service still orders After=var-lib-mica.mount, but it no longer touches STATE -- the shadow file is built in /run. A storage dependency that is not needed delays the unit behind a mount that can fail." >&2; exit 1
fi
for dep in micad.service dropbear.service; do
    grep -qE "^Before=.*\b${dep}\b" "${unit}" ||
        { echo "error: mica-shadow-reconcile.service does not order Before=${dep}" >&2; exit 1; }
done
test -f /rootfs/etc/systemd/system/dropbear.service ||
    { echo "error: mica-shadow-reconcile.service orders Before=dropbear.service but that unit is not in the image; systemd drops such an ordering silently" >&2; exit 1; }
echo "shadow: mica-shadow-reconcile.service enabled and ordered before its readers"
