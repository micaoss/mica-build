#!/bin/sh
# Fail the build on CJK text in a mica-owned image file.
#
# Called from rootfs/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.

set -e
    mica_paths=""
    for f in /rootfs/usr/lib/mica /rootfs/etc/mica \
             /rootfs/usr/lib/udev/rules.d/60-mica-*.rules \
             /rootfs/usr/lib/systemd/system/mica-*.service \
             /rootfs/usr/lib/systemd/system/micad.service \
             /rootfs/usr/lib/systemd/system/apid.service \
             /rootfs/usr/share/dbus-1/system.d/com.mica.micad.conf \
             /rootfs/etc/systemd/network/*.network \
             /rootfs/etc/systemd/system/mica-*.service \
             /rootfs/etc/systemd/system/dropbear.service \
             /rootfs/etc/systemd/system/etc-hostname.mount \
             /rootfs/etc/systemd/system/etc-wpa_supplicant.mount \
             /rootfs/etc/systemd/system/etc-hostapd.mount \
             /rootfs/etc/systemd/system/var-lib-mica.mount \
             /rootfs/etc/repart.d /rootfs/etc/fstab \
             /rootfs/etc/fw_env.config; do
        if [ -e "$f" ]; then mica_paths="$mica_paths $f"; fi
    done
    test -n "$mica_paths"
    hits=$(grep -rlP '[\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{f900}-\x{faff}]' \
        $mica_paths 2>/dev/null || true)
    if [ -n "$hits" ]; then
        echo 'CJK text found in mica-owned image files:' >&2
        echo "$hits" >&2
        exit 1
    fi
