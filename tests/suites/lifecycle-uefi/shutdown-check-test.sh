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
cat > "$WORK/openrc-good" <<'LOG'
PID1: Received "poweroff" from FIFO...
Starting shutdown runlevel
 * Stopping micad ... [ ok ]
 * Unbinding DATA ...EXT4-fs (vda3): re-mounted 5ac35760-09fd-4000-8000-000000000103 ro.
 [ ok ]
Sending the final kill signal
reboot: Power down
LOG
bash "$HERE/shutdown-check.sh" "$WORK/openrc-good" poweroff openrc
# A kernel that stamps its messages (CONFIG_PRINTK_TIME, the generic UEFI boards) interleaves the same lines.
cat > "$WORK/openrc-stamped" <<'LOG'
PID1: Received "poweroff" from FIFO...
Starting shutdown runlevel
 * Unbinding DATA ...[   55.338376] EXT4-fs (vda3): re-mounted 5ac35760-0064-4000-8000-000000000103 ro.
 [ ok ]
[   58.636572] reboot: Power down
LOG
bash "$HERE/shutdown-check.sh" "$WORK/openrc-stamped" poweroff openrc
python3 - "$WORK" <<'PY'
from pathlib import Path
import sys
root=Path(sys.argv[1]);good=(root/'openrc-good').read_text()
changes={
    'openrc-missing': good.replace(' * Unbinding DATA','missing'),
    'openrc-action': good.replace('reboot: Power down','reboot: Restarting system'),
    'openrc-error': good.replace(' * Stopping micad ... [ ok ]',' * ERROR: micad failed to stop'),
    'openrc-order': '\n'.join(reversed(good.splitlines()))+'\n',
    'openrc-duplicate': good+good,
    'openrc-stamp-garbage': good.replace('reboot: Power down','[ 58.6x] reboot: Power down'),
}
for name,text in changes.items(): (root/name).write_text(text)
PY
for case in openrc-missing openrc-action openrc-error openrc-order openrc-duplicate openrc-stamp-garbage; do
    if bash "$HERE/shutdown-check.sh" "$WORK/$case" poweroff openrc > "$WORK/result" 2>&1; then
        echo "FAIL: invalid shutdown evidence accepted: $case" >&2; exit 1
    fi
done
printf '%s\n' SHUTDOWN_CHECK_TEST_PASS
