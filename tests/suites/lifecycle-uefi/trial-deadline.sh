#!/bin/bash
# The trial deadline (mica-core watchdog-20261115, `mica-deploy trial-deadline`): a trial boot that is not confirmed
# within the boot policy's board.watchdog.confirmS seconds of uptime is failed and rebooted, three times, and the
# device falls back; a trial boot confirmed in time is left running. Fresh copies of the current factory image; the
# deployment is held before the health gate by test-trial-hold (trial-hold.sh, laid by runtime-build.sh) when
# /var/lib/mica/trial-hold names it.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=$(realpath "${1:?runtime evidence required}")
board=${2:?board required}
confirm=${3:?the product confirmS required}
init=${4:?init required}
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
work=$(mktemp -d "$PWD/_out/trial-deadline.XXXXXX")
printf 'Evidence: %s\n' "$work"
bad=$(sed -n 's/.*mica-init: verified deployment \([a-f0-9]\{64\}\);.*/\1/p' "$evidence/runtime.log" | sed -n '1p')
[[ "$bad" =~ ^[a-f0-9]{64}$ ]]
# A boot: up to confirmS, the deadline's reboot, and the boot itself under TCG.
limit=$((confirm + 300))
prepare() { # <dir> <hold line>
    mkdir "$1"
    cp --reflink=auto --sparse=always "$evidence/image/factory-disk.img" "$1/disk.img"
    cp "$evidence/db.cert.pem" "$1/db.cert.pem"
    printf '%s\n' "$2" >"$1/trial-hold"
    timeout -k 15 240 bash bin/bun.sh src/image/qemu-seed-data.ts "$board" "$1/disk.img" "$1/trial-hold" /state/mica/trial-hold
    python3 - "$1/boot.sh" <<'PY'
from pathlib import Path
import sys
source=Path('tests/suites/lifecycle-uefi/boot.sh').read_text()
assert source.count('-nographic -no-reboot')==1
Path(sys.argv[1]).write_text(source.replace('-nographic -no-reboot', '-qmp unix:/w/boot-events.sock,server=on,wait=off -nographic -no-reboot'))
PY
}
boot() { # <dir> <name> <limit>: the boot's exit status
    local rc=0
    # mica-build-side: container-block -- the QMP recorder runs in the lab image, on the bun it carries
    timeout -k 15 $(($3 + 60)) docker run --rm --label ai-agent=true --network traefik -v "$1:/w" -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bun /harness/qmp-boot.ts "/w/events-$2.jsonl" bash /w/boot.sh disk.img writable "$3" "$arch" >"$1/$2.log" 2>&1 || rc=$?
    # mica-build-side: host
    echo "$rc"
}
events() { # <events file> <reset|no-reset>
    python3 - "$1" "$2" <<'PY'
import json,sys
from pathlib import Path
records=[json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
assert not any(r.get('event')=='WATCHDOG' for r in records),records
if sys.argv[2]=='reset': assert any(r.get('event')=='SHUTDOWN' for r in records),records
else: assert all(r['data'].get('reason')=='host-signal' for r in records if r.get('event')=='SHUTDOWN'),records
PY
}
entries() { # <dir> <name>
    docker run --rm --label ai-agent=true --network traefik -v "$1:/w:ro" ai-agent/mica-p2-lab \
        mdir -i /w/disk.img@@1M -b ::/loader/entries >"$1/entries-$2.txt"
}
console() { tr -d '\r' <"$1"; }

echo "step trial: $bad held before the health gate, confirmS ${confirm}s, three boots"
out="$work/trial"
prepare "$out" "$bad"
for attempt in 1 2 3; do
    rc=$(boot "$out" "attempt-$attempt" "$limit")
    [ "$rc" = 0 ] || { echo "error: attempt $attempt ended with $rc, not the deadline's reboot; see $out/attempt-$attempt.log" >&2; exit 1; }
    log="$out/attempt-$attempt.log"
    console "$log" | grep -aF "FILE_AB_TRIAL_HOLD: $bad held (gate)" >/dev/null
    ! console "$log" | grep -aF FILE_AB_RUNTIME_PASS >/dev/null
    last=$(console "$log" | grep -aoE "FILE_AB_TRIAL_HOLD: $bad held \(gate\), up [0-9]+ s" | sed -n '$p' | sed -E 's/.* up ([0-9]+) s/\1/')
    [ "$last" -ge $((confirm - 10)) ] || { echo "error: attempt $attempt was last held at ${last}s, short of confirmS ${confirm}s; see $log" >&2; exit 1; }
    if console "$log" | grep -aF 'the trial was not confirmed within' >/dev/null; then
        console "$log" | grep -aE "this boot is on trial; it is failed unless confirmed within ${confirm}s of boot" >/dev/null
        console "$log" | grep -aE "the trial was not confirmed within ${confirm}s; failing the boot" >/dev/null
        said=yes
    else
        [ "$init" = openrc ] || { echo "error: attempt $attempt: no deadline line on the console; see $log" >&2; exit 1; }
        said="no (OpenRC: its lines go to the syslog, not copied to the console)"
    fi
    events "$out/events-attempt-$attempt.jsonl" reset
    entries "$out" "$attempt"
    grep -F "mica-$bad+$((3 - attempt))-$attempt.conf" "$out/entries-$attempt.txt" >/dev/null ||
        { echo "error: after attempt $attempt the entry is not mica-$bad+$((3 - attempt))-$attempt.conf: $(cat "$out/entries-$attempt.txt")" >&2; exit 1; }
    echo "step trial attempt $attempt: held to ${last}s, failed and rebooted without a watchdog reset; deadline lines on the console: $said; entry mica-$bad+$((3 - attempt))-$attempt.conf"
done
rc=$(boot "$out" fallback 450)
[ "$rc" = 0 ] || { echo "error: the fallback boot ended with $rc; see $out/fallback.log" >&2; exit 1; }
console "$out/fallback.log" | grep -aF FILE_AB_RUNTIME_PASS >/dev/null
! console "$out/fallback.log" | grep -aF "mica-init: verified deployment $bad;" >/dev/null
fallback=$(console "$out/fallback.log" | sed -n 's/.*mica-init: verified deployment \([a-f0-9]\{64\}\);.*/\1/p' | sed -n 1p)
bash tests/suites/lifecycle-uefi/shutdown-check.sh "$out/fallback.log" poweroff "$init" >/dev/null
echo "step trial fallback: $fallback booted and passed the runtime acceptance"

echo "step confirmed: $bad confirmed at once on its trial boot, held past confirmS"
out="$work/confirmed"
prepare "$out" "$bad confirm"
rc=$(boot "$out" boot $((confirm + 120)))
[ "$rc" = 124 ] || { echo "error: the confirmed boot ended with $rc, not the harness's timeout (124); see $out/boot.log" >&2; exit 1; }
log="$out/boot.log"
console "$log" | grep -aF "FILE_AB_TRIAL_CONFIRMED: $bad" >/dev/null
last=$(console "$log" | grep -aoE "FILE_AB_TRIAL_HOLD: $bad held \(confirm\), up [0-9]+ s" | sed -n '$p' | sed -E 's/.* up ([0-9]+) s/\1/')
[ "$last" -ge $((confirm + 30)) ] || { echo "error: the confirmed boot was last seen at ${last}s, short of confirmS ${confirm}s + 30; see $log" >&2; exit 1; }
! console "$log" | grep -aF 'failing the boot' >/dev/null
said="no (OpenRC syslog)"
if console "$log" | grep -aF '"confirmed":true' >/dev/null; then said=$(console "$log" | grep -aoF '"confirmed":true' | sed -n 1p)
elif [ "$init" != openrc ]; then echo "error: the deadline did not say the trial was confirmed; see $log" >&2; exit 1
fi
events "$out/events-boot.jsonl" no-reset
entries "$out" confirmed
grep -F "mica-$bad.conf" "$out/entries-confirmed.txt" >/dev/null ||
    { echo "error: the confirmed entry is not mica-$bad.conf: $(cat "$out/entries-confirmed.txt")" >&2; exit 1; }
echo "step confirmed: up ${last}s with no reboot and no watchdog reset; deadline said: $said; entry mica-$bad.conf"

if [ "$init" = openrc ]; then
    echo "step early (observation): $bad held in the boot runlevel before mica-data-layout"
    out="$work/early"
    prepare "$out" "$bad early"
    rc=$(boot "$out" boot $((confirm + 120)))
    log="$out/boot.log"
    seen=$(console "$log" | grep -aoE "FILE_AB_TRIAL_HOLD: $bad held \(early\), up [0-9]+ s" | sed -n '$p' || true)
    deadline=$(console "$log" | grep -acE 'Starting the trial deadline|failing the boot' || true)
    resets=$(python3 -c 'import json,sys; print(sum(1 for l in open(sys.argv[1]) if json.loads(l).get("event") in ("WATCHDOG","SHUTDOWN")))' "$out/events-boot.jsonl")
    echo "step early: exit $rc; last hold line: ${seen:-none (the hold could not read DATA there)}; deadline lines: $deadline; reset/shutdown events: $resets"
fi
echo "TRIAL_DEADLINE_PASS: $board confirmS ${confirm}s ($init)"
