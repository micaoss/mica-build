#!/usr/bin/env bash
# mica-build-side: container -- the device tree QEMU's virt machine hands this board, recorded as the FIT's.
#
#   dump.sh <output.dtb>     run in the signed-boot lab image (tests/suites/signed-boot-lab/Dockerfile.lab),
#                            whose qemu-system-arm comes from the Debian archive mica-system-base pins
#
# The machine is the one the board boots on: virt without high memory, a Cortex-A15, 128 MiB. QEMU writes a
# fresh rng-seed and kaslr-seed into /chosen on every run; they are removed, since the FIT's device tree is
# signed and has to be the same bytes every time (the kernel seeds itself without them), and the blob is
# rewritten by dtc, which leaves none of the removed bytes behind.
set -euo pipefail
[ "$#" -eq 1 ] || { echo 'usage: dump.sh <output.dtb>' >&2; exit 1; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
qemu-system-arm -M virt,highmem=off,dumpdtb="$work/virt.dtb" -cpu cortex-a15 -m 128M -nographic >/dev/null
fdtput -d "$work/virt.dtb" /chosen rng-seed
fdtput -d "$work/virt.dtb" /chosen kaslr-seed
dtc -q -I dtb -O dtb -o "$1" "$work/virt.dtb"
[ "$(fdtget -t s "$1" /flash@0 compatible)" = cfi-flash ]
echo "dump.sh: $(qemu-system-arm --version | sed -n '1p'): $(stat -c%s "$1") bytes"
