#!/bin/bash
# The factory reset of a gpt board (mica-core:docs/mica-core.md 3.7, 6.5), over the runtime image a product already
# booted: one boot stages it on the confirmed deployment, the next boot's runkit makes DATA again with the root's
# mke2fs as board.dataFormat says, restores meta/ from the snapshot on SYSTEM, and micad finishes it. Each boot runs
# the runtime suite with this step's actions.sh on the offline media (runtime.sh), `booted` and `fail` in scope.
#
#   bash tests/suites/lifecycle-uefi/factory-reset.sh <runtime evidence> <board>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
board=${2:?board required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test ! -e "$evidence/offline"
out="$evidence/factory-reset"
rm -rf "$out"
mkdir -p "$out"

step() {
    local name=$1 actions=$2
    rm -rf "$evidence/offline"
    mkdir -p "$evidence/offline"
    printf '%s\n' "$actions" >"$evidence/offline/actions.sh"
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 400 "$arch" >"$out/$name.log" 2>&1 || true
    rm -rf "$evidence/offline"
    grep -aF "FILE_AB_STEP_PASS: $name" "$out/$name.log" >/dev/null && grep -aF FILE_AB_RUNTIME_PASS "$out/$name.log" >/dev/null ||
        { echo "error: step $name failed; see $out/$name.log" >&2; grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$name.log" >&2 || true; exit 1; }
    echo "step $name: $(grep -a -E 'mica-init: factory reset|FILE_AB_STEP_PASS|FILE_AB_RESET_' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
}
# A value the guest printed as `FILE_AB_RESET_<key>: <value>`.
value() { grep -a "^FILE_AB_RESET_$2: " "$out/$1.log" | tail -n 1 | cut -d' ' -f2- | tr -d '\r'; }

# 1. Staged on the confirmed deployment, with markers on DATA a reset must not leave and the facts the next boot is
# held to: DATA's creation time, the firmware receipt and the deployment.
step staged "$(cat <<'ACTIONS'
for _ in $(seq 1 90); do mica-deploy status | grep -F "\"current\":\"$booted\"" >/dev/null && break; sleep 1; done
mica-deploy status | grep -F "\"current\":\"$booted\"" >/dev/null || fail 'the booted deployment is not confirmed'
[ "$(mica-deploy status | grep -o '"rootfs[_I][a-z]*"' | wc -l)" -gt 1 ] || fail 'the image holds one deployment; the reset would remove none'
data=$(findmnt -no SOURCE /mnt/data)
echo "FILE_AB_RESET_CREATED: $(dumpe2fs -h "$data" 2>/dev/null | sed -n 's/^Filesystem created: *//p')"
echo "FILE_AB_RESET_FIRMWARE: $(sha256sum /mnt/data/meta/firmware.json | cut -d' ' -f1)"
echo "FILE_AB_RESET_DEPLOYMENT: $booted"
printf 'state marker\n' > /mnt/data/state/factory-reset-marker
mkdir -p /srv/factory-reset && printf 'srv marker\n' > /srv/factory-reset/marker
printf 'var marker\n' > /var/lib/factory-reset-marker
r=$(mica-deploy factory-reset --by cli --source lifecycle-uefi) || fail "the factory reset was not staged: $r"
echo "staged: $r"
mica-deploy status | grep -F '"factoryReset":{' | grep -F '"state":"staged"' >/dev/null || fail 'status does not name the staged reset'
echo "FILE_AB_STEP_PASS: staged"
ACTIONS
)"
created=$(value staged CREATED) firmware=$(value staged FIRMWARE) deployment=$(value staged DEPLOYMENT)
[ -n "$created" ] && [ -n "$firmware" ] && [ -n "$deployment" ] || { echo "error: the staged boot did not report DATA's creation time, the firmware receipt and the deployment" >&2; exit 1; }

# 2. The reset carried out: the runkit says it made DATA again, DATA is a new filesystem without the markers, meta/
# holds the restored receipt, catalog and deployment state, the finish left one deployment and recorded the reset.
step reset "created='$created' firmware='$firmware' deployment='$deployment'
$(cat <<'ACTIONS'
[ "$booted" = "$deployment" ] || fail "the reset booted $booted, not the deployment it was staged on ($deployment)"
data=$(findmnt -no SOURCE /mnt/data)
now=$(dumpe2fs -h "$data" 2>/dev/null | sed -n 's/^Filesystem created: *//p')
[ -n "$now" ] && [ "$now" != "$created" ] || fail "DATA was not made again: created '$now', before the reset '$created'"
for m in /mnt/data/state/factory-reset-marker /srv/factory-reset /var/lib/factory-reset-marker; do
    [ ! -e "$m" ] || fail "DATA after the reset still holds $m"
done
for f in firmware.json catalog.json deployments.json; do [ -s "/mnt/data/meta/$f" ] || fail "meta/$f was not restored"; done
[ "$(sha256sum /mnt/data/meta/firmware.json | cut -d' ' -f1)" = "$firmware" ] || fail 'meta/firmware.json is not the receipt staged in the snapshot'
done=/mnt/data/meta/factory-reset-done.json
[ -s "$done" ] || fail 'no meta/factory-reset-done.json'
echo "done: $(cat "$done")"
grep -F '"v":2' "$done" >/dev/null && grep -F '"formatted":true' "$done" >/dev/null || fail 'the reset record is not v 2 with formatted true'
mica-deploy status > /run/mica/reset-status.json || fail 'status after the reset'
! grep -F '"factoryReset"' /run/mica/reset-status.json >/dev/null || fail "status still names a factory reset: $(cat /run/mica/reset-status.json)"
[ "$(grep -o '"rootfs[_I][a-z]*"' /run/mica/reset-status.json | wc -l)" = 1 ] || fail "the reset left more than one deployment: $(cat /run/mica/reset-status.json)"
echo "FILE_AB_STEP_PASS: reset"
ACTIONS
)"
grep -aE 'mica-init: factory reset to deployment [^ ]+: DATA made again' "$out/reset.log" >/dev/null ||
    { echo "error: the runkit did not report DATA made again; see $out/reset.log" >&2; exit 1; }
echo "FACTORY_RESET_PASS: DATA made again, markers gone, meta/ restored, one deployment, record v 2 formatted"
