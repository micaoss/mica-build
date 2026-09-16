#!/bin/bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
command -v docker >/dev/null
work=$(mktemp -d "$PWD/_out/fit-firmware-io.XXXXXX")
image=$(bash tools/from.sh --ref mica-build-env:c)
# The empty headers isolate hardware declarations; the complete production C
# policy is included unchanged and called through its normal entry point.
# mica-build-side: container-block -- the pinned C compiler builds and runs the firmware policy.
docker run --rm --label ai-agent=true --network traefik -v "$PWD:/src:ro" -v "$work:/out" \
    --entrypoint /bin/bash "$image" -ceu '
    mkdir -p /out/include/amlogic /out/include/asm /out/include/u-boot
    for header in common cli amlogic/storage blk bootm button command console dm env fs hang image malloc memalign mmc part wdt asm/unaligned u-boot/crc; do
        touch /out/include/$header.h
    done
    for board in cx3576 s905x5m; do
    flags=
    [ "$board" != s905x5m ] || flags=-DS905X5M
    gcc $flags -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
        -I/out/include -I/src/_out/src/mica-boards.cx3576/common/uboot /src/tests/lifecycle-uboot-fit/firmware-io.c -o /out/firmware-io
    timeout 20 /out/firmware-io
    done
'
# mica-build-side: host
