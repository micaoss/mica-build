#!/bin/bash
# mica-build-side: container -- exercise the pinned drivers with simulated MMIO.
set -euo pipefail
[ "$#" = 1 ] || { echo 'usage: watchdog.sh UBOOT_SOURCE' >&2; exit 1; }
source_dir=$(realpath "$1")
tests_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/include/asm" "$work/include/linux"
for header in clk dm reset wdt asm/io linux/bitops; do touch "$work/include/$header.h"; done
python3 - "$source_dir" "$work" <<'PY'
import pathlib, re, sys
source=pathlib.Path(sys.argv[1]); out=pathlib.Path(sys.argv[2])
clock=(source/'drivers/clk/rockchip/clk_rk3576.c').read_text()
ops=clock.split('static struct clk_ops rk3576_clk_ops = {',1)[1].split('};',1)[0]
match=re.search(r'\.enable\s*=\s*(\w+)',ops)
if match:
 name=match[1]
 start=clock.index('static int '+name+'(')
 end=clock.index('\n}',start)+2
 adapter=clock[start:end]+f'\nstatic int (*rk3576_enable)(struct clk *) = {name};\n'
else:
 adapter='static int (*rk3576_enable)(struct clk *) = NULL;\n'
(out/'clock-enable.h').write_text(adapter)
rockusb=(source/'cmd/rockusb.c').read_text()
start=rockusb.index('\twhile (1) {')
end=rockusb.index('\n\t}', start)+3
(out/'recovery-loop.h').write_text(rockusb[start:end]+'\n')
(out/'watchdog-driver.h').write_text(f'#include "{source}/drivers/watchdog/designware_wdt.c"\n')
PY
gcc -std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter -fsanitize=address,undefined \
    -I"$work/include" -I"$work" -I"$source_dir/dts/upstream/include" \
    "$tests_dir/watchdog.c" -o "$work/watchdog"
"$work/watchdog"
gcc -std=gnu11 -Wall -Wextra -Werror -fsanitize=address,undefined \
    -I"$work" "$tests_dir/rockusb-watchdog.c" -o "$work/rockusb-watchdog"
"$work/rockusb-watchdog"
