#!/usr/bin/env bash
# Validate evidence parsing without treating fixture text as a guest action.
set -euo pipefail
for tool in bash python3 mktemp; do command -v "$tool" >/dev/null; done
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
WORK=$(mktemp -d)
trap 'rm -r "$WORK"' EXIT
cat > "$WORK/good" <<'LOG'
Entering exitrd...
MICA_SHUTDOWN stage=entered action=poweroff source=exitrd deployment=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
MICA_SHUTDOWN stage=quiesced detail="users=0"
MICA_SHUTDOWN stage=empty-observation detail="mounts=0 mappings=0 loops=0 backings=0"
MICA_SHUTDOWN stage=storage-released detail="observations=2 mounts=0 mappings=0 loops=0 backings=0"
MICA_SHUTDOWN stage=action-requested action=poweroff
LOG
bash "$HERE/shutdown-check.sh" "$WORK/good" poweroff
python3 - "$WORK" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]);good=(root/'good').read_text()
changes={
    'old': 'Entering exitrd...\nAll filesystems, swaps, loop devices, MD devices and DM devices detached.\n',
    'missing': good.replace('MICA_SHUTDOWN stage=storage-released','missing'),
    'dirty': good.replace('loops=0','loops=1'),
    'action': good.replace('action=poweroff','action=reboot'),
    'failure': good+'MICA_SHUTDOWN stage=failed watchdogArmed=true\n',
    'returned': good+'MICA_SHUTDOWN stage=storage-not-released error="terminal action returned"\n',
    'order': '\n'.join(reversed(good.splitlines()))+'\n',
    'injected': good.replace('MICA_SHUTDOWN stage=storage-released','prefix MICA_SHUTDOWN stage=storage-released'),
    'duplicate': good+good,
}
for name,text in changes.items(): (root/name).write_text(text)
PY
for case in old missing dirty action failure returned order injected duplicate; do
    if bash "$HERE/shutdown-check.sh" "$WORK/$case" poweroff > "$WORK/result" 2>&1; then
        echo "FAIL: invalid shutdown evidence accepted: $case" >&2; exit 1
    fi
done
printf '%s\n' SHUTDOWN_CHECK_TEST_PASS
