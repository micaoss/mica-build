#!/bin/sh
# Assert bounded writable var and protected state on an OpenRC root: mica-openrc's mica-mounts (boot runlevel)
# binds DATA's var tree over /var and STATE over /var/lib/mica, after mica-seed-var; the log is busybox syslogd's,
# in RAM.
#
# Called from stages/compose/90-pack.Dockerfile (pack stage) through init-steps.sh.
set -eu
test -L /rootfs/var/lib/dbus/machine-id ||
    { echo "error: /var/lib/dbus/machine-id is not a symlink; a baked D-Bus id is per-image identity on a disposable filesystem" >&2; exit 1; }
mounts=/rootfs/etc/init.d/mica-mounts
for bind in 'bind /mnt/data/var /var nosuid,nodev' 'bind /mnt/data/state/mica /var/lib/mica'; do
    grep -qF "${bind}" "${mounts}" || { echo "error: ${mounts} does not carry '${bind}'" >&2; exit 1; }
done
test -L /rootfs/etc/runlevels/boot/mica-mounts ||
    { echo "error: mica-mounts is not in the boot runlevel; /var would stay on the read-only root" >&2; exit 1; }
test -x /rootfs/usr/lib/mica/mica-seed-var
test -d /rootfs/var/lib/mica || { echo "error: /var/lib/mica is missing from the var template" >&2; exit 1; }
echo "precious: /var -> DATA and /var/lib/mica -> DATA state via mica-mounts"
