#!/bin/bash
# Whether a rollback took (mica-core CG-S04, 67cd770), over a copy of the runtime image a product already booted:
# one boot rolls the confirmed deployment back to its retained fallback, the next boot runs the fallback and micad's
# update state says lastRollback rolled_back with that target, and the boot after it says nothing. Then
# `mica-deploy rollback --reboot` from the shell: it rolls back and reboots through the root's init (systemctl, or
# openrc-shutdown on OpenRC, whose root has no reboot on mica-deploy's path), and the next boot runs its target.
# Each boot runs the runtime suite with this step's actions.sh on the offline media (runtime.sh), `booted`, `fail`
# and `bus` in scope. The runtime image itself is left as it was.
#
#   bash tests/suites/lifecycle-uefi/rollback-outcome.sh <runtime evidence> <board> <init>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
board=${2:?board required}
init=${3:?init required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test ! -e "$evidence/offline"
out="$evidence/rollback-outcome"
rm -rf "$out"
mkdir -p "$out"
# The steps change the deployment state on the disk; the runtime image goes back as it was when they end.
cp --reflink=auto --sparse=always "$evidence/image/disk.img" "$out/runtime-disk.img"
restore() { mv -f "$out/runtime-disk.img" "$evidence/image/disk.img"; rm -rf "$evidence/offline"; }
trap restore EXIT

step() {
    local name=$1 actions=$2
    rm -rf "$evidence/offline"
    mkdir -p "$evidence/offline"
    printf '%s\n' "$actions" >"$evidence/offline/actions.sh"
    rc=0
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 400 "$arch" >"$out/$name.log" 2>&1 || rc=$?
    echo "$rc" >"$out/$name.rc"
    rm -rf "$evidence/offline"
    ! grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$name.log" >/dev/null && grep -aF "FILE_AB_STEP_PASS: $name" "$out/$name.log" >/dev/null ||
        { echo "error: step $name failed; see $out/$name.log" >&2; grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$name.log" >&2 || true; exit 1; }
    echo "step $name: $(grep -a -E 'FILE_AB_STEP_PASS|FILE_AB_ROLLBACK_' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
}
# A value the guest printed as `FILE_AB_ROLLBACK_<key>: <value>`.
value() { grep -a "^FILE_AB_ROLLBACK_$2: " "$out/$1.log" | tail -n 1 | cut -d' ' -f2- | tr -d '\r'; }

# 1. The confirmed deployment rolled back to its retained fallback over micad's bus; this boot reports no outcome.
step staged "$(cat <<'ACTIONS'
status=$(mica-deploy status)
target=$(printf '%s' "$status" | grep -o '"fallback":"[0-9a-f]\{64\}"' | cut -d'"' -f4)
[ -n "$target" ] && [ "$target" != "$booted" ] || fail "no retained fallback to roll back to: $status"
bus RollbackDeployment s "$booted" || fail 'micad refused the rollback'
bus GetUpdateState | tr -d '\\' > /run/mica/rollback-staged.json || fail 'update state after the rollback'
! grep -F '"lastRollback"' /run/mica/rollback-staged.json >/dev/null || fail 'lastRollback in the boot the rollback was staged in'
echo "FILE_AB_ROLLBACK_FROM: $booted"
echo "FILE_AB_ROLLBACK_TARGET: $target"
echo "FILE_AB_STEP_PASS: staged"
ACTIONS
)"
from=$(value staged FROM) target=$(value staged TARGET)
[ -n "$from" ] && [ -n "$target" ] || { echo "error: the staged boot did not report the deployment and its target" >&2; exit 1; }

# 2. The fallback booted, and the update state says the rollback took, to that target.
step outcome "from='$from' target='$target'
$(cat <<'ACTIONS'
[ "$booted" = "$target" ] || fail "booted $booted, not the rollback target $target"
bus GetUpdateState | tr -d '\\' > /run/mica/rollback-outcome.json || fail 'update state after the rollback boot'
outcome=$(grep -o '"lastRollback":{[^}]*}' /run/mica/rollback-outcome.json) || fail "no lastRollback: $(cat /run/mica/rollback-outcome.json)"
echo "FILE_AB_ROLLBACK_OUTCOME: $outcome"
case "$outcome" in *'"outcome":"rolled_back"'*) ;; *) fail "the rollback is not reported rolled_back: $outcome" ;; esac
case "$outcome" in *"\"target\":\"$target\""*) ;; *) fail "the outcome names another target: $outcome" ;; esac
# Read again in the same boot: the outcome stays for this boot.
bus GetUpdateState | tr -d '\\' | grep -F '"outcome":"rolled_back"' >/dev/null || fail 'the outcome did not stay for the boot it was decided in'
echo "FILE_AB_STEP_PASS: outcome"
ACTIONS
)"

# 3. A boot after that: the outcome is gone.
step cleared "target='$target'
$(cat <<'ACTIONS'
[ "$booted" = "$target" ] || fail "booted $booted, not the rolled-back-to $target"
bus GetUpdateState | tr -d '\\' > /run/mica/rollback-cleared.json || fail 'update state a boot later'
! grep -F '"lastRollback"' /run/mica/rollback-cleared.json >/dev/null || fail "lastRollback a boot after it was reported: $(cat /run/mica/rollback-cleared.json)"
echo "FILE_AB_STEP_PASS: cleared"
ACTIONS
)"
# 4. `mica-deploy rollback --reboot` from the shell, on the runtime image as it was (the rolled-back-to deployment
# keeps no fallback): to the same target, and the guest reboots by itself (boot.sh runs QEMU with -no-reboot, so the
# reboot ends the run at once, long before its limit).
cp --reflink=auto --sparse=always "$out/runtime-disk.img" "$evidence/image/disk.img"
step reboot "from='$from'
$(cat <<'ACTIONS'
[ "$booted" = "$from" ] || fail "booted $booted, not $from"
back=$(mica-deploy status | grep -o '"fallback":"[0-9a-f]\{64\}"' | cut -d'"' -f4)
[ -n "$back" ] && [ "$back" != "$booted" ] || fail "no retained fallback to roll back to: $(mica-deploy status)"
echo "FILE_AB_ROLLBACK_BACK: $back"
echo "FILE_AB_STEP_PASS: reboot"
# It returns once it has asked the init (openrc-shutdown and systemctl do not wait); the reboot follows.
mica-deploy rollback --reboot >/dev/console 2>&1 || fail "mica-deploy rollback --reboot failed: $?"
sleep 120
fail 'no reboot within 120 s of mica-deploy rollback --reboot'
ACTIONS
)"
back=$(value reboot BACK)
[ "$(cat "$out/reboot.rc")" = 0 ] || { echo "error: the rollback --reboot boot ended with $(cat "$out/reboot.rc"), not the guest's reboot; see $out/reboot.log" >&2; exit 1; }
! grep -aF FILE_AB_RUNTIME_PASS "$out/reboot.log" >/dev/null || { echo "error: the runtime acceptance ran on after rollback --reboot; see $out/reboot.log" >&2; exit 1; }
bash tests/suites/lifecycle-uefi/shutdown-check.sh "$out/reboot.log" reboot "$init" >/dev/null
step rebooted "back='$back'
$(cat <<'ACTIONS'
[ "$booted" = "$back" ] || fail "booted $booted after rollback --reboot, not $back"
echo "FILE_AB_STEP_PASS: rebooted"
ACTIONS
)"
echo "ROLLBACK_OUTCOME_PASS: rolled back from $from to $target, reported rolled_back in that boot alone; rollback --reboot to $back rebooted ($init)"
