#!/bin/sh
# The systemd root's links and state directories: the resolver is resolved's stub, and timesyncd, networkd,
# the timers, lingering and the random seed keep their state under /var/lib/systemd, the seed on STATE.
set -eu
ln -sf ../run/systemd/resolve/stub-resolv.conf /rootfs/etc/resolv.conf
for name in timesync network timers linger; do mkdir -p "/rootfs/var/lib/systemd/$name"; done
rm -f /rootfs/var/lib/systemd/random-seed
ln -s /mnt/data/state/random-seed /rootfs/var/lib/systemd/random-seed
