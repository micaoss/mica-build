#!/bin/sh
# Prepare the initial var template copied to bounded DATA before its bind mount.
set -eu
mkdir -p /out
mv /rootfs/rootfs-report.txt /out/rootfs-report.txt
mv /rootfs/rootfs-report.pkglogs /out/pkg-logs
ln -sf ../run/systemd/resolve/stub-resolv.conf /rootfs/etc/resolv.conf
printf 'mica\n' > /rootfs/etc/hostname
printf '127.0.1.1 mica\n' >> /rootfs/etc/hosts
: > /rootfs/etc/machine-id
rm -f /rootfs/var/cache/ldconfig/aux-cache
mkdir -p /rootfs/var/lib/dbus /rootfs/var/lib/systemd
for name in timesync network timers linger; do mkdir -p "/rootfs/var/lib/systemd/$name"; done
rm -f /rootfs/var/lib/systemd/random-seed
ln -s /mnt/data/state/random-seed /rootfs/var/lib/systemd/random-seed
mkdir -p /rootfs/var/tmp
chmod 1777 /rootfs/var/tmp
ln -sf ../../../etc/machine-id /rootfs/var/lib/dbus/machine-id
# Login accounting is volatile and bounded by /run, never an unbounded DATA log.
for file in wtmp btmp lastlog; do
    rm -f "/rootfs/var/log/$file"
    ln -s "/run/mica/$file" "/rootfs/var/log/$file"
done
