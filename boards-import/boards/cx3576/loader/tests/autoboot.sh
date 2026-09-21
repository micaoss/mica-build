#!/bin/bash
# mica-build-side: container -- run the pinned main loop with deterministic UART input.
set -euo pipefail
[ "$#" = 1 ] || { echo 'usage: autoboot.sh UBOOT_SOURCE' >&2; exit 1; }
source_dir=$(realpath "$1")
tests_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
python3 - "$source_dir" "$work" <<'PY'
import pathlib, re, sys
source = pathlib.Path(sys.argv[1]); out = pathlib.Path(sys.argv[2])
parts = []
for file, names in [
    ('common/autoboot.c', ['print_boot_delay', 'abortboot_single_key', 'abortboot',
                           'process_fdt_options', 'bootdelay_process', 'autoboot_command']),
    ('common/main.c', ['run_preboot_environment_command', 'main_loop']),
    ('cmd/bootm.c', ['do_bootd']),
]:
    text = (source / file).read_text()
    for name in names:
        start = re.search(r'^(?:static )?[^\n]+\b' + name + r'\([^;]*?\n\{', text, re.M).start()
        end = text.index('\n}', start) + 2
        parts.append(text[start:end])
code = '\n\n'.join(parts) + '\n'
(out / 'autoboot-path.h').write_text(code)
config = dict(re.findall(r'^(CONFIG_\w+)=(.*)$', (source / '.config').read_text(), re.M))
symbols = set(re.findall(r'IS_ENABLED\((CONFIG_\w+)\)', code))
symbols.update(['CONFIG_BOOTDELAY', 'CONFIG_BOOTCOMMAND', 'CONFIG_MICA_FILE_BOOT'])
(out / 'autoboot-config.h').write_text(''.join(
    f'#define {name} {"1" if config.get(name) == "y" else config.get(name, "0")}\n'
    for name in sorted(symbols)))
PY
gcc -std=gnu11 -Wall -Wextra -Werror -Wno-unused-parameter -fsanitize=address,undefined \
    -I"$work" "$tests_dir/autoboot.c" -o "$work/autoboot"
"$work/autoboot"
