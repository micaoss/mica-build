#!/usr/bin/env bash
# THE BOOT LOGO, derived here rather than committed, exactly as cx3576 does it.
# The vendor tree's logo_linux_clut224.ppm is REPLACED: the payload is 2.2 MB
# of ASCII PPM and a patch carrying it would be a 2.2 MB diff.
#
# common/kernel/splash.png is the master, shared by every board that draws a
# logo. It arrives through the family's common kernel directory, so this board
# adds no new build input of its own.
#
# 720x405 IS A CONSTRAINT, NOT A PREFERENCE. fb_prepare_logo drops the logo
# when its height exceeds the mode's yres and fb_show_logo_line copies nothing
# when its width will not fit xres; both failures are a blank screen, not an
# error. This geometry fits every mode from 800x600 up.
#
#   prepare.sh <source-tree> <board-dir> <family-common-kernel-dir>
set -euo pipefail
SRC="$1"
BOARD_DIR="$2"
COMMON="$3"
python3 "${COMMON}/mklogo.py" "${COMMON}/splash.png" \
    "${SRC}/drivers/video/logo/logo_linux_clut224.ppm" 720 405
