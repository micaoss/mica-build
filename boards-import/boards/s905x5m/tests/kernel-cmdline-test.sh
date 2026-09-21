#!/usr/bin/env bash
# The forced kernel command line and the board declaration say the same thing:
# CONFIG_CMDLINE in kernel/config/signed-boot.fragment, CONFIG_CMDLINE_FORCE=y
# beside it, and BOARD_CMDLINE_ARGS in board.env.
#
# WHY THIS FILE EXISTS, WHICH IS A DEFECT IT WOULD HAVE CAUGHT. cx3576 has had
# this check since the logo round; this board did not, and on 2026-09-20 the
# two diverged in a published release. board.env gained
# `fbcon=logo-pos:center,logo-count:1 vt.global_cursor_default=0` and the
# fragment did not, so `s905x5m.20260920-1536` shipped a kernel whose forced
# line lacks both -- measured in the published component, not in this file.
#
# NOTHING ELSE WOULD HAVE CAUGHT IT. This board keeps CONFIG_CMDLINE in a
# FRAGMENT rather than in its committed vendor config (cx3576's home), and
# common/kernel/set-profile.sh reads the line out of the resolved .config and
# appends the profile token -- IT NEVER READS board.env. The board's own
# hooks/assert.sh compares the fragment against .config, which is the same
# statement twice: both were stale together and it passed. The only gate that
# sees the divergence is mica-build:build/src/kernel-package.ts:149, in another
# repository, after the product build has started.
#
# ON A FIT BOARD THIS IS NOT COSMETIC: the kernel is built with CMDLINE_FORCE,
# so the built-in line is what the device boots with and no bootloader can add
# a missing token later.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
fragment=kernel/config/signed-boot.fragment
kernel="$(sed -n '/^CONFIG_CMDLINE="/{s/^CONFIG_CMDLINE="\(.*\)"$/\1/;p;q;}' "${fragment}")"
board="$(sed -n '/^BOARD_CMDLINE_ARGS=/{s/^BOARD_CMDLINE_ARGS="\{0,1\}\([^"]*\)"\{0,1\}$/\1/;p;q;}' board.env)"
[ -n "${kernel}" ] || { echo "FAIL: ${fragment} declares no CONFIG_CMDLINE" >&2; exit 1; }
[ -n "${board}" ] || { echo "FAIL: board.env declares no BOARD_CMDLINE_ARGS" >&2; exit 1; }
grep -qx 'CONFIG_CMDLINE_FORCE=y' "${fragment}" || { echo "FAIL: ${fragment} does not force the command line (CONFIG_CMDLINE_FORCE=y)" >&2; exit 1; }
[ "${kernel}" = "${board}" ] || {
    echo "FAIL: CONFIG_CMDLINE and BOARD_CMDLINE_ARGS differ. The kernel forces its line, so the device boots the first one and the board declares the second:" >&2
    echo "  kernel: ${kernel}" >&2
    echo "  board:  ${board}" >&2
    exit 1
}
# The profile token is added at build time by common/kernel/set-profile.sh, so
# the board line must not carry one: two tokens is a different failure.
case " ${kernel} " in *" mica.profile"* | *" mica.recovery"*) echo "FAIL: the board line already names mica.profile or mica.recovery" >&2; exit 1 ;; esac
# BOARD_BOOT_LOGO=1 on this board, and two of the five artefacts it moves are
# command-line tokens (tests/board-contract-test.sh holds the other three).
for arg in 'fbcon=logo-pos:center,logo-count:1' 'vt.global_cursor_default=0'; do
    case " ${kernel} " in *" ${arg} "*) ;; *) echo "FAIL: the command line lacks ${arg}" >&2; exit 1 ;; esac
done
echo "PASS: CONFIG_CMDLINE is forced and equals BOARD_CMDLINE_ARGS (${kernel})"
