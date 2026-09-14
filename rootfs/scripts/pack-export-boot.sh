#!/bin/sh
# Kernel/support and boot firmware are produced independently of the user root.
set -eu
for path in /rootfs/usr/lib/modules /rootfs/usr/lib/firmware /rootfs/boot; do
    mkdir -p "$path"
    [ -z "$(find "$path" -mindepth 1 -print -quit)" ] || {
        echo "error: rootfs contains a kernel component at ${path#/rootfs}" >&2; exit 1;
    }
done
mkdir -p /out/boot
