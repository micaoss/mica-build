#!/usr/bin/env bash
# The forced kernel command line and the board declaration say the same
# thing: CONFIG_CMDLINE in the committed kernel config, CONFIG_CMDLINE_FORCE=y
# beside it, and BOARD_CMDLINE_ARGS in board.env -- one centered HDMI logo,
# no VT cursor. The assembly (mica-build:build/src/kernel-display.test.ts)
# holds the other leg, its authenticated packaging constant against
# board.env; this is the leg that reads the kernel configuration.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
config=kernel/config/kernel-cx3576z.config
kernel="$(sed -n '/^CONFIG_CMDLINE="/{s/^CONFIG_CMDLINE="\(.*\)"$/\1/;p;q;}' "${config}")"
board="$(sed -n '/^BOARD_CMDLINE_ARGS=/{s/^BOARD_CMDLINE_ARGS="\{0,1\}\([^"]*\)"\{0,1\}$/\1/;p;q;}' board.env)"
[ -n "${kernel}" ] || { echo "FAIL: ${config} declares no CONFIG_CMDLINE" >&2; exit 1; }
[ -n "${board}" ] || { echo "FAIL: board.env declares no BOARD_CMDLINE_ARGS" >&2; exit 1; }
grep -qx 'CONFIG_CMDLINE_FORCE=y' "${config}" || { echo "FAIL: ${config} does not force the command line (CONFIG_CMDLINE_FORCE=y)" >&2; exit 1; }
[ "${kernel}" = "${board}" ] || { echo "FAIL: CONFIG_CMDLINE and BOARD_CMDLINE_ARGS differ:" >&2; echo "  kernel: ${kernel}" >&2; echo "  board:  ${board}" >&2; exit 1; }
for arg in 'fbcon=logo-pos:center,logo-count:1' 'vt.global_cursor_default=0'; do
    case " ${kernel} " in *" ${arg} "*) ;; *) echo "FAIL: the command line lacks ${arg}" >&2; exit 1 ;; esac
done
echo "PASS: CONFIG_CMDLINE is forced and equals BOARD_CMDLINE_ARGS (${kernel})"
