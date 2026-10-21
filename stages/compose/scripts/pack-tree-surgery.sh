#!/bin/sh
# Prepare the initial var template copied to bounded DATA before its bind mount.
set -eu
mkdir -p /out
mv /rootfs/rootfs-report.txt /out/rootfs-report.txt
mv /rootfs/rootfs-report.pkglogs /out/pkg-logs
printf 'mica\n' > /rootfs/etc/hostname
# /etc/hosts is the Base's link to /run/mica/hosts, which mica-hosts writes at boot with this name.
: > /rootfs/etc/machine-id
rm -f /rootfs/var/cache/ldconfig/aux-cache
mkdir -p /rootfs/var/lib/dbus
mkdir -p /rootfs/var/tmp
chmod 1777 /rootfs/var/tmp
ln -sf ../../../etc/machine-id /rootfs/var/lib/dbus/machine-id
# Login accounting is volatile and bounded by /run, never an unbounded DATA log.
for file in wtmp btmp lastlog; do
    rm -f "/rootfs/var/log/$file"
    ln -s "/run/mica/$file" "/rootfs/var/log/$file"
done
