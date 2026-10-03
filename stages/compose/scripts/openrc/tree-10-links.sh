#!/bin/sh
# The OpenRC root's resolver: what mica-openrc's udhcpc writes. mica-openrc's own link is diverted while dpkg runs
# (compose-install.sh), because the build bind-mounts /etc/resolv.conf.
set -eu
ln -sf ../run/mica/resolv.conf /rootfs/etc/resolv.conf
