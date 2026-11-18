#!/bin/sh
# The update path from a released round (update-from-release.sh), in the guest: one script on DATA, run as the
# user's own service on every boot, whichever deployment booted. /mnt/data/state/ufr/ids names the released
# deployment (OLD), the update's (NEW) and the archive's size and SHA-256; the archive is the raw disk vdb.
#   boot 1, OLD, stage none:  health confirms OLD; the archive is imported through micad, installed, rebooted into
#   boot 2, NEW, stage A:     the trial boot of NEW: its policy carries board.watchdog, the deadline runs
#                             and health confirms; then micad rolls NEW back to OLD and reboots
#   boot 3, OLD, stage B:     OLD is back on its own core set and its own policy, the rollback is reported, health
#                             confirms, and no log line of this boot refuses a field
exec >/dev/console 2>&1
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
D=/mnt/data/state/ufr
say() { echo "UFR_$1: $2"; }
INIT=$(sed -n 's/^INIT=//p' /usr/lib/mica/product.conf)
power_off() { if [ "$INIT" = systemd ]; then systemctl --no-block poweroff; else openrc-shutdown --poweroff now; fi; }
fail() { say FAIL "$*"; sync; sleep 3; power_off; sleep 60; exit 1; }
bus() {
    if [ "$INIT" = systemd ]; then busctl --system call com.mica.micad /com/mica/micad com.mica.micad1 "$@"; return; fi
    method=$1
    shift
    [ "$#" -eq 0 ] || shift
    for arg in "$@"; do set -- "$@" "string:$arg"; shift; done
    dbus-send --system --print-reply --dest=com.mica.micad /com/mica/micad "com.mica.micad1.$method" "$@"
}
logs() { if [ "$INIT" = systemd ]; then journalctl -b --no-pager -o cat; else logread; fi; }
state() { bus GetUpdateState 2>&1 | tr -d '\\'; }
# The lifecycle holds nested objects; its state is the document's one string-valued "state".
lifecycle() { state | grep -o '"state":"[a-z_]*"\|"deploymentId":"[0-9a-f]*"\|"failedDuring":"[a-z]*"' | tr '\n' ' '; }
# until <seconds> <what> <command...>
until_ok() {
    t=$1 what=$2
    shift 2
    i=0
    until "$@"; do i=$((i + 5)); [ "$i" -le "$t" ] || fail "$what not within ${t}s: $(state | cut -c1-1500)"; sleep 5; done
}
imported() {
    l=$(lifecycle)
    case "$l" in *'"state":"failed"'*) fail "the import failed: $l" ;; esac
    case "$l" in *'"state":"ready"'*) case "$l" in *"$NEW"*) return 0 ;; esac ;; esac
    return 1
}
candidate() {
    l=$(lifecycle)
    case "$l" in *'"state":"failed"'*) fail "the install failed: $l" ;; esac
    case "$(state)" in *"\"candidate\":\"$NEW\""*) return 0 ;; esac
    return 1
}
# The keys come in name order: "candidate" before "current".
confirmed() {
    s=$(state)
    case "$s" in *"\"current\":\"$1\""*) ;; *) return 1 ;; esac
    case "$s" in *'"candidate":null'*) return 0 ;; esac
    return 1
}
reboot_now() {
    for attempt in 1 2 3 4 5 6; do
        out=$(bus Reboot 2>&1) && { sleep 300; fail "no reboot within 300s of micad's Reboot"; }
        say NOTE "Reboot refused ($attempt): $out"
        sleep 15
    done
    fail "micad refused the reboot: $out"
}

read -r OLD NEW SIZE SHA NEWSET <"$D/ids" || fail "no $D/ids"
stage=$(cat "$D/stage" 2>/dev/null || echo none)
until_ok 300 'micad on the bus' bus GetUpdateState >/dev/null
booted=$(mica-deploy booted) || fail "mica-deploy booted: $booted"
say BOOT "stage $stage, booted $booted, up $(cut -d. -f1 /proc/uptime)s"
say CORE "$(cat /run/mica/core.json)"
say POLICY "$(tr -d '\n ' </run/mica/boot-policy.json | grep -o '"watchdog":{[^}]*}')"

case "$stage:$booted" in
"none:$OLD")
    # Boot 1: the released deployment, confirmed as it would be on a device.
    until_ok 600 "health confirming $OLD" confirmed "$OLD"
    cp /run/mica/core.json "$D/core-old.json"
    cp /run/mica/boot-policy.json "$D/policy-old.json"
    say STATE "$(state | grep -o '"state":{"candidate[^}]*}' | cut -c1-600)"
    # The upload a console makes: the archive written under the uploads directory, then ImportUpdate.
    uploads=/mica/updates/uploads
    mkdir -p "$uploads"
    out=$(dd if=/dev/vdb of="$uploads/next.micaupd" bs=1M count=$((SIZE / 1048576 + 1)) 2>&1 && truncate -s "$SIZE" "$uploads/next.micaupd" 2>&1) ||
        fail "copying the archive off vdb: $out; $(ls -l /dev/vd* 2>&1 | tr '\n' ' '); $(ls -ld "$uploads" 2>&1)"
    [ "$(sha256sum "$uploads/next.micaupd" | cut -d' ' -f1)" = "$SHA" ] || fail "the archive copied off vdb differs"
    bus ImportUpdate s "$uploads/next.micaupd" || fail "micad refused the import"
    until_ok 900 "the import of $NEW" imported
    say IMPORTED "$(lifecycle)"
    bus InstallUpdate s "$NEW" || fail "micad refused the install"
    until_ok 1200 "$NEW as the candidate" candidate
    say INSTALLED "$(lifecycle)"
    echo A >"$D/stage"
    sync
    say STEP_PASS "1 released $OLD imported, installed $NEW, rebooting"
    reboot_now
    ;;
"A:$NEW")
    # Boot 2: the update's trial boot, under the new core.
    # The board's watchdog policy (board.watchdog: identity?, handoverS?, confirmS?), read by the new core; and the
    # update's core set composed.
    grep -F '"watchdog":{' /run/mica/boot-policy.json >/dev/null && grep -F '"confirmS"' /run/mica/boot-policy.json >/dev/null ||
        fail "the new policy carries no board.watchdog with confirmS: $(cat /run/mica/boot-policy.json)"
    grep -F "\"coreSetId\":\"$NEWSET\"" /run/mica/core.json >/dev/null || fail "the update's core set $NEWSET is not composed: $(cat /run/mica/core.json)"
    s=$(state)
    case "$s" in *"\"candidate\":\"$NEW\""* | *"\"pending\":true"* | *'"trial"'*) say TRIAL "on trial at boot: yes" ;; *) say TRIAL "state at boot: $(printf '%s' "$s" | cut -c1-600)" ;; esac
    until_ok 900 "health confirming $NEW" confirmed "$NEW"
    lines=$(logs | grep -a 'mica-trial-deadline\|trial deadline\|on trial' | tail -n 8)
    say DEADLINE "$(printf '%s' "$lines" | tr '\n' '|')"
    printf '%s' "$lines" | grep -F 'this boot is on trial' >/dev/null || fail "the trial deadline did not see this boot as a trial"
    status=$(mica-deploy status) || fail "mica-deploy status: $status"
    case "$status" in *"\"fallback\":\"$OLD\""*) ;; *) fail "the fallback is not $OLD: $status" ;; esac
    say STATE "$(state | grep -o '"state":{"candidate[^}]*}' | cut -c1-600)"
    echo B >"$D/stage"
    sync
    bus RollbackDeployment s "$NEW" || fail "micad refused the rollback to $OLD"
    say STEP_PASS "2 $NEW booted on trial with the new policy, confirmed, rolled back to $OLD, rebooting"
    reboot_now
    ;;
"B:$OLD")
    # Boot 3: back on the released deployment, its core set and its own policy.
    cmp -s /run/mica/core.json "$D/core-old.json" || fail "the core set after the rollback: $(cat /run/mica/core.json), before: $(cat "$D/core-old.json")"
    cmp -s /run/mica/boot-policy.json "$D/policy-old.json" || fail "the policy after the rollback differs from the released one"
    until_ok 600 "health confirming $OLD again" confirmed "$OLD"
    s=$(state)
    outcome=$(printf '%s' "$s" | grep -o '"lastRollback":{[^}]*}') || fail "no lastRollback: $(printf '%s' "$s" | cut -c1-1500)"
    case "$outcome" in *'"outcome":"rolled_back"'*"\"target\":\"$OLD\""* | *"\"target\":\"$OLD\""*'"outcome":"rolled_back"'*) ;; *) fail "the rollback is not reported rolled_back to $OLD: $outcome" ;; esac
    say ROLLBACK "$outcome"
    refused=$(logs | grep -a -i -E 'unknown field|unknown variant|deny_unknown' | head -n 5)
    [ -z "$refused" ] || fail "a log line of the released core refuses a field: $refused"
    echo C >"$D/stage"
    sync
    say STEP_PASS "3 $OLD back on its own core set and policy, rollback reported, confirmed, no refused field"
    say PASS "released $OLD -> $NEW -> $OLD"
    power_off
    ;;
*) fail "unexpected: stage $stage with $booted booted (OLD $OLD, NEW $NEW)" ;;
esac
