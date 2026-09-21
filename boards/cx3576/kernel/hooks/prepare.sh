#!/usr/bin/env bash
# THE BOOT LOGO, derived here rather than committed. The vendor tree's
# logo_linux_clut224.ppm is REPLACED, which is why this is a file copy and not
# an entry in kernel/patches/: the payload is 2.2 MB of ASCII PPM, and a patch
# carrying it would be a 2.2 MB diff against a file whose every line changes.
#
# common/kernel/splash.png is the master (docs/design/display.md section 4),
# shared by every board that draws a logo since 2026-09-20: it arrives through
# the family's common kernel directory, which is already a named build context
# on both board families, so no board's build-context whitelist has to name it.
# Deriving the PPM from it at build time keeps ONE copy of the artwork in the
# tree. mklogo.py is pure integer arithmetic: two runs on one master produce
# one byte string, which a float resampler or a set-ordered quantiser would
# not.
#
# 720x405 IS A CONSTRAINT, NOT A PREFERENCE. fb_prepare_logo drops the logo
# when its height exceeds the mode's yres (fbmem.c:650-653) and
# fb_show_logo_line reduces the copy count to zero when its width will not fit
# xres (fbmem.c:513); both failures are a blank screen, not an error. This
# geometry fits every mode from 800x600 up.
#
#   prepare.sh <source-tree> <board-dir> <family-common-kernel-dir>
set -euo pipefail
SRC="$1"
BOARD_DIR="$2"
COMMON="$3"
python3 "${COMMON}/mklogo.py" "${COMMON}/splash.png" \
    "${SRC}/drivers/video/logo/logo_linux_clut224.ppm" 720 405
