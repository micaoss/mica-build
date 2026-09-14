#!/bin/sh
# Assert bounded writable var and protected credential storage.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.
# Build arguments read from the environment: MICA_RADIOS.

set -eu
# /var/lib/bluetooth only in a root that CARRIES Bluetooth (the product
# selected it): the pairing database is precious state there and does not
# exist at all in a root without the radio -- a minimal product on a board
# that has one -- where demanding its mount unit would fail a correct image.
precious="/var/lib/mica"
case " ${MICA_RADIOS} " in *" bluetooth "*) precious="${precious} /var/lib/bluetooth" ;; esac
for w in ${precious}; do
    unit="$(echo "${w#/}" | tr / -).mount"
    f="/rootfs/etc/systemd/system/${unit}"
    if [ ! -f "$f" ]; then
        echo "error: ${w} holds precious state but ${unit} does not exist" >&2; exit 1
    fi
    if [ ! -L "/rootfs/etc/systemd/system/local-fs.target.wants/${unit}" ]; then
        echo "error: ${unit} exists but is not enabled; ${w} would consume the general var quota" >&2; exit 1
    fi
    grep -q "^Where=${w}\$" "$f" || { echo "error: ${unit} does not mount ${w}" >&2; exit 1; }
    grep -qE "^What=/mnt/data/state/" "$f" || { echo "error: ${unit} is not backed by DATA state" >&2; exit 1; }
    if [ ! -d "/rootfs${w}" ]; then
        echo "error: ${w} is missing from the var template" >&2; exit 1
    fi
    echo "precious: ${w} -> DATA state via ${unit}"
done
grep -q '^Storage=volatile$' /rootfs/etc/systemd/journald.conf.d/00-volatile.conf ||
    { echo "error: journald is not Storage=volatile; the journal would fill the fixed-size /var" >&2; exit 1; }
echo "precious: journald Storage=volatile (journal never lands on /var)"
test -L /rootfs/var/lib/dbus/machine-id ||
    { echo "error: /var/lib/dbus/machine-id is not a symlink; a baked D-Bus id is per-image identity on a disposable filesystem" >&2; exit 1; }

grep -qx 'What=/mnt/data/var' /rootfs/etc/systemd/system/var.mount
grep -qx 'Where=/var' /rootfs/etc/systemd/system/var.mount
grep -qx 'Options=bind,private,nosuid,nodev' /rootfs/etc/systemd/system/var.mount
test -L /rootfs/etc/systemd/system/local-fs.target.wants/var.mount
test -x /rootfs/usr/lib/mica/mica-seed-var
test -f /rootfs/etc/systemd/system/mica-seed-var.service
for parent in var-lib var-cache var-log var-tmp var-lib-systemd-timesync \
              var-lib-systemd-network var-lib-systemd-timers var-lib-systemd-linger; do
    test ! -e "/rootfs/etc/systemd/system/$parent.mount" || {
        echo "error: obsolete $parent mount" >&2; exit 1;
    }
done
