#!/usr/bin/env bash
# Check ordered native shutdown evidence, the exitrd's or OpenRC's; external action/guest proof is separate.
set -euo pipefail
command -v python3 >/dev/null
log=${1:?boot log required}
action=${2:-poweroff}
init=${3:-systemd}
python3 - "$log" "$action" "$init" <<'PY'
from pathlib import Path
import re
import sys
path, action, init = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
if action not in {'reboot', 'poweroff', 'halt'}:
    raise SystemExit('Unsupported expected shutdown action')
if init not in {'systemd', 'openrc'}:
    raise SystemExit('Unsupported init')
if path.stat().st_size > 64 * 1024 * 1024:
    raise SystemExit('Excessive shutdown log')
lines = path.read_text(errors='replace').splitlines()
# Under OpenRC there is no exit ramdisk: openrc-init runs the shutdown runlevel, mica-mounts leaves DATA read-only,
# and the kernel takes the action.
# A kernel built with CONFIG_PRINTK_TIME stamps its own lines, the generic UEFI boards' among them.
stamp = r'(?:\[ *[0-9]+\.[0-9]{6}\] )?'
openrc_patterns = [
    rf'PID1: Received "{action}" from FIFO\.\.\.',
    r'Starting (?:shutdown|reboot) runlevel',
    rf' \* Unbinding DATA \.\.\.{stamp}EXT4-fs \(\w+\): re-mounted [0-9a-f-]+ ro\.',
    stamp + {'poweroff': r'reboot: Power down', 'reboot': r'reboot: Restarting system', 'halt': r'reboot: System halted'}[action],
]
patterns = openrc_patterns if init == 'openrc' else [
    rf'MICA_SHUTDOWN stage=entered action={action} source=exitrd deployment=[0-9a-f]{{64}}',
    r'MICA_SHUTDOWN stage=quiesced detail="users=0"',
    r'MICA_SHUTDOWN stage=empty-observation detail="mounts=0 mappings=0 loops=0 backings=0"',
    r'MICA_SHUTDOWN stage=storage-released detail="observations=2 mounts=0 mappings=0 loops=0 backings=0"',
    rf'MICA_SHUTDOWN stage=action-requested action={action}',
]
positions = []
for pattern in patterns:
    matches = [i for i, line in enumerate(lines) if re.fullmatch(pattern, line)]
    if len(matches) != 1:
        raise SystemExit(f'Missing or duplicate native shutdown evidence: {pattern}')
    positions.append(matches[0])
if positions != sorted(positions):
    raise SystemExit('Native shutdown evidence is out of order')
if init == 'openrc':
    for line in lines[positions[1]:]:
        if line.startswith(' * ERROR: '):
            raise SystemExit(f'Shutdown failure evidence: {line}')
for line in lines:
    if re.match(r'MICA_SHUTDOWN stage=(failed|storage-not-released)\b', line) or any(
        marker in line for marker in ('Unable to finalize remaining', 'Failed to execute shutdown binary', 'Failed to switch root to')
    ):
        raise SystemExit(f'Shutdown failure evidence: {line}')
print(f'SHUTDOWN_LOG_CHECK_PASS action={action} externalActionProof=pending')
PY
