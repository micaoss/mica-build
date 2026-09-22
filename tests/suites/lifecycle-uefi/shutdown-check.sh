#!/usr/bin/env bash
# Check ordered native exitrd evidence; external action/guest proof is separate.
set -euo pipefail
command -v python3 >/dev/null
log=${1:?boot log required}
action=${2:-poweroff}
python3 - "$log" "$action" <<'PY'
from pathlib import Path
import re
import sys
path, action = Path(sys.argv[1]), sys.argv[2]
if action not in {'reboot', 'poweroff', 'halt'}:
    raise SystemExit('Unsupported expected shutdown action')
if path.stat().st_size > 64 * 1024 * 1024:
    raise SystemExit('Excessive shutdown log')
lines = path.read_text(errors='replace').splitlines()
patterns = [
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
for line in lines:
    if re.match(r'MICA_SHUTDOWN stage=(failed|storage-not-released)\b', line) or any(
        marker in line for marker in ('Unable to finalize remaining', 'Failed to execute shutdown binary', 'Failed to switch root to')
    ):
        raise SystemExit(f'Shutdown failure evidence: {line}')
print(f'SHUTDOWN_LOG_CHECK_PASS action={action} externalActionProof=pending')
PY
