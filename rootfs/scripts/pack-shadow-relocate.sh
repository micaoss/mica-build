#!/bin/sh
# Move /etc/shadow onto a tmpfs symlink and retain the factory copy.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.

set -eu
test -f /rootfs/etc/shadow && test ! -L /rootfs/etc/shadow
mkdir -p /rootfs/usr/share/factory/etc
cp -a /rootfs/etc/shadow /rootfs/usr/share/factory/etc/shadow
chmod 0640 /rootfs/usr/share/factory/etc/shadow
ln -sfn /run/mica/shadow /rootfs/etc/shadow
echo "shadow: /etc/shadow -> /run/mica/shadow (tmpfs), factory copy retained"
