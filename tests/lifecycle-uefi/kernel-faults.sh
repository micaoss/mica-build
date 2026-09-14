#!/bin/bash
# Panic and watchdog-reset trials against fresh copies of the complete current image.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
evidence=$(realpath "${1:?runtime evidence required}")
board=${2:?board required}
# The board's facts, out of its fetched bundle: the suite boots UEFI boards
# of either architecture and dispatches on nothing else.
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
work=$(mktemp -d "$PWD/_out/kernel-faults.XXXXXX")
printf 'Evidence: %s\n' "$work"
bad=$(sed -n 's/.*mica-init: verified deployment \([a-f0-9]\{64\}\);.*/\1/p' "$evidence/boot.log" | head -1)
[[ "$bad" =~ ^[a-f0-9]{64}$ ]]
for mode in panic watchdog; do
 out="$work/$mode"
 mkdir "$out"
 cp --reflink=auto --sparse=always "$evidence/image/factory-disk.img" "$out/disk.img"
 cp "$evidence/db.cert.pem" "$out/db.cert.pem"
 cat > "$out/kernel-fault.sh" <<SCRIPT
#!/bin/sh
set -eu
[ "\$(mica-deploy booted)" = "$bad" ] || exit 0
[ "\$(cat /proc/sys/kernel/panic)" = 5 ]
if [ "$mode" = watchdog ]; then echo 0 > /proc/sys/kernel/panic; fi
echo 'FILE_AB_KERNEL_FAULT_TRIGGER: $mode' > /dev/console
echo c > /proc/sysrq-trigger
exit 1
SCRIPT
 cat > "$out/kernel-fault.service" <<'UNIT'
[Unit]
Description=Kernel failure acceptance before health confirmation
Before=mica-health.service
[Service]
Type=oneshot
ExecStart=/bin/sh /var/lib/mica/kernel-fault.sh
[Install]
WantedBy=multi-user.target
UNIT
 timeout -k 15 240 bun tools/qemu-seed-data.ts "$board" "$out/disk.img" \
   "$out/kernel-fault.sh" /state/mica/kernel-fault.sh \
   "$out/kernel-fault.service" /state/systemd-units/kernel-fault.service --enable kernel-fault.service
 # Only add event observation to a private copy of the existing harness.
 python3 - "$out/boot.sh" <<'PY'
from pathlib import Path
import sys
source=Path('tests/lifecycle-uefi/boot.sh').read_text()
assert source.count('-nographic -no-reboot')==1
Path(sys.argv[1]).write_text(source.replace('-nographic -no-reboot', '-qmp unix:/w/boot-events.sock,server=on,wait=off -nographic -no-reboot'))
PY
 for attempt in 1 2 3; do
  timeout -k 15 450 docker run --rm --label ai-agent=true --network traefik -v "$out:/w" -v "$PWD/tests/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
    python3 /harness/qmp-boot.py "/w/events-$attempt.jsonl" bash /w/boot.sh disk.img writable 400 "$arch" > "$out/attempt-$attempt.log" 2>&1
  grep -F "FILE_AB_KERNEL_FAULT_TRIGGER: $mode" "$out/attempt-$attempt.log"
  grep -F 'Kernel panic - not syncing: sysrq triggered crash' "$out/attempt-$attempt.log"
  ! grep -F FILE_AB_RUNTIME_PASS "$out/attempt-$attempt.log"
  python3 - "$out/events-$attempt.jsonl" "$mode" <<'PY'
import json,sys
from pathlib import Path
records=[json.loads(line)for line in Path(sys.argv[1]).read_text().splitlines()]
watchdog=[r for r in records if r.get('event')=='WATCHDOG']
assert any(r.get('event')=='SHUTDOWN' for r in records),records
if sys.argv[2]=='watchdog': assert watchdog and watchdog[-1]['data']['action']=='reset',records
else: assert not watchdog,records
PY
  left=$((3-attempt))
  docker run --rm --label ai-agent=true --network traefik -v "$out:/w:ro" ai-agent/mica-p2-lab \
    mdir -i /w/disk.img@@1M -b ::/loader/entries > "$out/entries-$attempt.txt"
  grep -F "mica-$bad+$left-$attempt.conf" "$out/entries-$attempt.txt"
 done
 timeout -k 15 450 docker run --rm --label ai-agent=true --network traefik -v "$out:/w" -v "$PWD/tests/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
   bash /harness/boot.sh disk.img writable 400 "$arch" > "$out/fallback.log" 2>&1
 grep -F FILE_AB_RUNTIME_PASS "$out/fallback.log"
 ! grep -F "mica-init: verified deployment $bad;" "$out/fallback.log"
 bash tests/lifecycle-uefi/shutdown-check.sh "$out/fallback.log"
 printf 'FILE_AB_KERNEL_FAULT_FALLBACK_PASS: %s %s\n' "$board" "$mode"
done
