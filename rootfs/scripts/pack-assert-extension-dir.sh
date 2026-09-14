#!/bin/sh
# Assert the writable unit directory exists and is DATA state-backed.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.

set -eu
ext_dir=/usr/local/lib/systemd/system
ext_unit=usr-local-lib-systemd-system.mount
f="/rootfs/etc/systemd/system/${ext_unit}"
if [ ! -d "/rootfs${ext_dir}" ]; then
    echo "error: ${ext_dir} is not in the packed root; a verity root cannot create it at runtime, so ${ext_unit} fails at boot and no extension unit can ever be installed" >&2; exit 1
fi
if [ ! -f "$f" ]; then
    echo "error: ${ext_unit} does not exist; ${ext_dir} would stay on the read-only squashfs and a unit written there would vanish at reboot" >&2; exit 1
fi
if [ ! -L "/rootfs/etc/systemd/system/local-fs.target.wants/${ext_unit}" ]; then
    echo "error: ${ext_unit} exists but is not enabled; the directory would never be bound and installing a unit would appear to work until the next boot" >&2; exit 1
fi
grep -q "^Where=${ext_dir}\$" "$f" || { echo "error: ${ext_unit} does not mount ${ext_dir}" >&2; exit 1; }
grep -qE "^What=/mnt/data/state/" "$f" || { echo "error: ${ext_unit} is not backed by DATA state, so installed units would not survive an A/B update" >&2; exit 1; }
echo "extensions: ${ext_dir} -> DATA state via ${ext_unit}"
