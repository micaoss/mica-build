#!/bin/sh
# The OpenRC half of the shadow chain: mica-openrc's mica-shadow-reconcile runs in the default runlevel after
# mica-mounts and before micad and apid, and micad's SSH server needs it.
#
# Called from stages/compose/90-pack.Dockerfile (pack stage) through init-steps.sh, after pack-assert-shadow-chain.sh.
set -eu
script=/rootfs/etc/init.d/mica-shadow-reconcile
test -x "${script}" && test -x /rootfs/usr/lib/mica/mica-shadow-reconcile
test -L /rootfs/etc/runlevels/default/mica-shadow-reconcile ||
    { echo "error: mica-shadow-reconcile is not in the default runlevel; /etc/shadow would never converge with the image accounts" >&2; exit 1; }
grep -qE '^[[:space:]]*before .*\bmicad\b.*\bapid\b' "${script}" ||
    { echo "error: ${script} does not order itself before micad and apid; they would find no /etc/shadow" >&2; exit 1; }
# The SSH server's scripts: mica-sshd, which both SSH servers ship and micad starts, wherever the product has ssh,
# and mica-dropbear, mica-ssh's same server under its former name, wherever it is in the image.
features=" $(sed -n 's/^FEATURES="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /rootfs/usr/lib/mica/product.conf) "
case "${features}" in *" ssh "*)
    test -e /rootfs/etc/init.d/mica-sshd ||
        { echo "error: the product has ssh and the image carries no /etc/init.d/mica-sshd; micad starts the SSH server by that name" >&2; exit 1; } ;;
esac
for server in mica-sshd mica-dropbear; do
    [ -e "/rootfs/etc/init.d/${server}" ] || continue
    grep -qE '^[[:space:]]*need .*\bmica-shadow-reconcile\b' "/rootfs/etc/init.d/${server}" ||
        { echo "error: ${server} does not need mica-shadow-reconcile; the SSH server would find no /etc/shadow" >&2; exit 1; }
done
echo "shadow: mica-shadow-reconcile in the default runlevel and ordered before its readers"
