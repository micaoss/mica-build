#!/bin/sh
# mica-build-side: container -- PID 1 of the proof initramfs; nothing in this
#   file runs on a host.
#
# One initramfs, two experiments. /proc first, because the mode is read from
# the kernel command line and nothing else has mounted it yet.
mount -t proc proc /proc 2>/dev/null
if grep -q "mica.mode=switchroot" /proc/cmdline; then
    exec /init-switchroot.sh
fi
exec /init-matrix.sh
