#!/bin/bash
# Core sets on a device (mica-core:docs/mica-core.md 6.2 "Core sets"), over the runtime image a product already booted
# and confirmed: the device runs its seed set, general generation 1. One boot per step; each step's media
# (runtime.sh's actions hook) carries what the guest installs and checks, and the host reads the runkit's console.
# Scenarios:
#   1  the image boots from its seed set, which status reports as current                      (step A)
#   2  a core update alone: on trial, committed by the health gate, its trial gone             (A, B)
#   3  a bad set: three boots spent, the fourth composes the current set, the bad one dropped,
#      and the deployment never retired                                                        (E, F1-F3, G)
#   4  a channel switch, through micad and a served catalog, to a lower generation of the other
#      channel; then a system update from the product line of the same catalog                 (M-P)
#   5  a root the current set does not select on is refused until a set for both levels is
#      committed                                                                               (H-L)
#   6  no core set while a deployment is on trial, and no deployment while a set is pending   (A, C)
#   7  a pending set with a component missing is passed over and dropped, the current set
#      composed throughout; a current set with a component missing stops the boot             (R, S1-S3, T, U)
#
#   bash tests/suites/lifecycle-uefi/core-sets.sh <runtime evidence> <cert> <key> <runkit> <board> <cores>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
certificate=${2:?public content certificate required}
key=${3:?external content key required}
runkit=${4:?compiled mica-runkit required}
board=${5:?board required}
cores=${6:?the signed core components of the product required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test ! -e "$evidence/offline"
out="$evidence/core-sets"
mkdir -p "$out"

boot() {
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 300 "$arch" >"$1" 2>&1 || true
}
expect() { grep -F -- "$2" "$1" >/dev/null || { echo "FAIL: $1 does not report: $2" >&2; tail -n 60 "$1" >&2; exit 1; }; }
refute() { ! grep -F -- "$2" "$1" >/dev/null || { echo "FAIL: $1 reports: $2" >&2; tail -n 60 "$1" >&2; exit 1; }; }
set_of() { timeout 360s bun tests/suites/lifecycle-uefi/core-set.ts "$evidence" "$certificate" "$key" "$cores" "$@" >&2; cat "$evidence/core-sets/$1-$2/id"; }
deployment_of() {
    # A deployment from update.ts, moved out of the evidence root where the default flow would install it.
    local generation=$1 kind=$2
    timeout 900s bun tests/suites/lifecycle-uefi/update.ts "$evidence" "$certificate" "$key" "$generation" "$kind" "$evidence/root" "$evidence/kernel" "$runkit" >&2
    mv "$evidence/offline" "$out/deploy-$generation"
    cat "$out/deploy-$generation/expected-id"
}
# step <name> <actions>: the media for one boot (lib.sh, actions.sh, the archives and deployments it names), then the boot.
step() {
    local name=$1 actions=$2
    rm -rf "$evidence/offline"
    mkdir -p "$evidence/offline/sets"
    cp "$out/lib.sh" "$evidence/offline/lib.sh"
    printf '. /run/mica/import/lib.sh\n%s\n' "$actions" >"$evidence/offline/actions.sh"
    for s in "$evidence"/core-sets/*/core.micaupd; do [ -f "$s" ] && cp "$s" "$evidence/offline/sets/$(basename "$(dirname "$s")").micaupd"; done
    for d in "$out"/deploy-*; do [ -d "$d" ] && cp -r "$d" "$evidence/offline/"; done
    boot "$out/$name.log"
    echo "step $name: $(grep -a -E 'mica-init: core set|FILE_AB_STEP_PASS|FILE_AB_RUNTIME_FAIL' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
}
pass() { expect "$out/$1.log" "FILE_AB_STEP_PASS: $1"; expect "$out/$1.log" FILE_AB_RUNTIME_PASS; }

cat >"$out/lib.sh" <<'LIB'
# Guest helpers for core-sets.sh steps.
core_status() { mica-deploy status > /run/mica/core-status.json || fail 'core set status'; echo "status: $(cat /run/mica/core-status.json)"; }
status_has() { grep -F -- "$1" /run/mica/core-status.json >/dev/null; }
# core_is current|pending <id>: the core set status names that set there (its keys are sorted, the id not first).
core_is() { grep -E -- "\"$1\":\{[^}]*\"id\":\"$2\"" /run/mica/core-status.json >/dev/null; }
import_set() {
    r=$(mica-deploy --max-bytes 536870912 import "/run/mica/import/sets/$1.micaupd") || fail "core archive acquisition: $1"
    echo "import: $r"
    echo "$r" | grep -F '"kind":"set"' >/dev/null || fail "$1 was not read as a core set"
}
install_set() { mica-deploy set-install "/mica/updates/verified/set-core-$1.json" --objects /mica/updates/verified/objects; }
install_deploy() { mica-deploy install "/run/mica/import/deploy-$1/deployment.json" --objects "/run/mica/import/deploy-$1/objects"; }
# refused <what> <expected words> <command...>: the command fails, naming the expected words.
refused() {
    what=$1 words=$2; shift 2
    if "$@" > /run/mica/refusal.log 2>&1; then cat /run/mica/refusal.log; fail "$what was not refused"; fi
    echo "refused: $(cat /run/mica/refusal.log)"
    grep -F -- "$words" /run/mica/refusal.log >/dev/null || fail "$what was refused without saying: $words"
}
wait_current() {
    for n in $(seq 1 100); do
        mica-deploy status > /run/mica/core-status.json || fail 'core set status'
        if core_is current "$1" && status_has '"pending":null'; then echo "status: $(cat /run/mica/core-status.json)"; return 0; fi
        sleep 1
    done
    core_status
    fail "the core set $1 was not made current"
}
# bus_wait <words> <what>: micad's update state comes to name the words.
bus_wait() {
    for n in $(seq 1 120); do
        bus GetUpdateState | tr -d '\\' > /run/mica/update-state.json || fail 'update state'
        grep -F -- "$1" /run/mica/update-state.json >/dev/null && return 0
        sleep 1
    done
    cat /run/mica/update-state.json
    fail "$2"
}
# follow <channel>: micad dials the served catalog and follows the channel.
follow() {
    mkdir -p /mica/config
    printf '{"channels":{"core":"%s"},"source":{"url":"http://10.0.2.2:8000/update/"}}\n' "$1" > /mica/config/updates.json
}
# drop_component <component id>: the component's image leaves its path, as a damaged store would have it. Renamed
# and not removed: the image of a composed component is mapped, and SYSTEM does not go read-only over an unlinked
# file that is still open.
drop_component() {
    mount -o remount,rw /mnt/system || fail 'SYSTEM writable'
    mv "/mnt/system/sets/core/objects/$1/core.img" "/mnt/system/sets/core/objects/$1/core.img.gone" || fail "no component $1 to drop"
    sync
    mount -o remount,ro /mnt/system || fail 'SYSTEM read-only'
}
no_candidate() { mica-deploy status | grep -F '"candidate":null' >/dev/null || fail "$1 left a deployment candidate"; }
LIB

seed=$(cat "$evidence/seed-core-set.id")
g2=$(set_of general 2)
g3=$(set_of general 3 --micad exits)
g4=$(set_of general 4 --root-max 1)
g5=$(set_of general 5 --root-max 2)
l1=$(set_of lts 1 --root-max 2)
l2=$(set_of lts 2 --root-max 2)
d3=$(deployment_of 3 root)
d4=$(deployment_of 4 root-next-level)
d5=$(deployment_of 5 root)
micad_of() { sed -n 's/.*"id":"\([0-9a-f]\{64\}\)".*/\1/p' "$evidence/core-sets/$1/cores/micad/core.json"; }
rm -rf "$evidence/www"
timeout 600s bun tests/suites/lifecycle-uefi/core-catalog.ts "$evidence/www/update" http://10.0.2.2:8000/update/ \
    --core "$evidence/core-sets/general-5" --core "$evidence/core-sets/lts-1" \
    --product "$out/deploy-5" --objects "$evidence/kernel" >&2
echo "sets: seed $seed, g2 $g2, g3 (bad) $g3, g4 (root 1..1) $g4, g5 (root 1..2) $g5, l1 (lts) $l1, l2 (lts) $l2; deployments: d3 $d3, d4 (next root level) $d4, d5 (served) $d5"

# A: the seed set is current (1); install g2; a deployment is refused while it is pending (6).
step A "core_status
core_is current $seed || fail 'the seed core set is not the current one'
status_has '\"pending\":null' || fail 'a factory device holds a pending core set'
[ ! -e /usr/share/doc/micad/core-proof ] || fail 'the micad composed is not the seed set'\"'\"'s'
import_set general-2
install_set $g2 || fail 'core set installation'
core_status
core_is pending $g2 || fail 'the installed core set is not pending'
status_has '\"attemptsLeft\":3' || fail 'the pending set has not three boots'
refused 'a deployment while a core set is pending' 'a set is on trial' install_deploy 3
no_candidate 'a refused deployment'
echo \"FILE_AB_STEP_PASS: A over \$booted\""
expect "$out/A.log" "mica-init: core set $seed (general generation 1)"
pass A
deployment=$(sed -n 's/^FILE_AB_STEP_PASS: A over //p' "$out/A.log" | tr -d '\r')

# B: g2 on trial, committed (2).
step B "wait_current $g2
[ ! -e /mnt/data/meta/set-trial.json ] || fail 'the core trial outlived the commit'
grep -F 'core-set=general-2' /usr/share/doc/micad/core-proof >/dev/null || fail 'the micad composed is not the set'\"'\"'s'
no_candidate 'a core update'
echo \"FILE_AB_STEP_PASS: B over \$booted\""
expect "$out/B.log" "mica-init: core set $g2 (general generation 2), on trial"
pass B
expect "$out/B.log" "FILE_AB_STEP_PASS: B over $deployment"

# C: a system update goes on trial over g2; a core set is refused while it is (6).
step C "install_deploy 3 || fail 'deployment installation over a core set'
refused 'a core set while a deployment is on trial' 'a deployment is on trial' mica-deploy --max-bytes 536870912 import /run/mica/import/sets/general-3.micaupd
core_status
status_has '\"pending\":null' || fail 'a refused core set is pending'
echo \"FILE_AB_STEP_PASS: C over \$booted\""
expect "$out/C.log" "mica-init: core set $g2 (general generation 2)"
pass C

# D: the new deployment boots on g2 and is confirmed.
step D "[ \"\$booted\" = $d3 ] || fail \"booted \$booted, not the updated deployment $d3\"
core_status
core_is current $g2 || fail 'the system update moved the core set'
echo \"FILE_AB_STEP_PASS: D over \$booted\""
pass D

# E: the bad set goes on trial.
step E "import_set general-3
install_set $g3 || fail 'core set installation'
core_status
core_is pending $g3 || fail 'the bad set is not pending'
echo \"FILE_AB_STEP_PASS: E over \$booted\""
pass E

# F1-F3: its three boots, none healthy (3).
for attempt in 1 2 3; do
    step "F$attempt" "echo \"FILE_AB_STEP_PASS: F$attempt over \$booted\""
    expect "$out/F$attempt.log" "mica-init: core set $g3 (general generation 3), on trial"
    expect "$out/F$attempt.log" '"retired":false,"setTrial":"core"'
    refute "$out/F$attempt.log" FILE_AB_RUNTIME_PASS
done

# G: the fourth boot composes g2, the health gate drops g3, and the deployment is still d3 (3).
step G "wait_current $g2
[ \"\$booted\" = $d3 ] || fail \"booted \$booted: the bad core set retired the deployment\"
grep -F 'core-set=general-2' /usr/share/doc/micad/core-proof >/dev/null || fail 'the fallback did not compose the current set'
[ ! -e /mnt/data/meta/set-trial.json ] || fail 'the spent trial outlived the fallback'
echo \"FILE_AB_STEP_PASS: G over \$booted\""
expect "$out/G.log" "mica-init: core set $g2 (general generation 2)"
refute "$out/G.log" "mica-init: core set $g3"
pass G

# H, I: g4 (root 1..1) on trial and committed.
step H "import_set general-4
install_set $g4 || fail 'core set installation'
echo \"FILE_AB_STEP_PASS: H over \$booted\""
pass H
step I "wait_current $g4
echo \"FILE_AB_STEP_PASS: I over \$booted\""
expect "$out/I.log" "mica-init: core set $g4 (general generation 4), on trial"
pass I

# J: the next root level is refused over g4; g5 (root 1..2) goes on trial (5).
step J "refused 'a root the current core set does not select on' 'update the core set first' install_deploy 4
no_candidate 'a refused deployment'
import_set general-5
install_set $g5 || fail 'core set installation'
echo \"FILE_AB_STEP_PASS: J over \$booted\""
pass J

# K: g5 committed; the next root level now installs (5).
step K "wait_current $g5
install_deploy 4 || fail 'the next root level was refused over a set that runs on it'
echo \"FILE_AB_STEP_PASS: K over \$booted\""
expect "$out/K.log" "mica-init: core set $g5 (general generation 5), on trial"
pass K

# L: it boots, on g5.
step L "[ \"\$booted\" = $d4 ] || fail \"booted \$booted, not the next-level deployment $d4\"
core_status
core_is current $g5 || fail 'the root update moved the core set'
echo \"FILE_AB_STEP_PASS: L over \$booted\""
expect "$out/L.log" "mica-init: core set $g5 (general generation 5)"
pass L

# M: micad, told to follow lts, finds l1 below g5's generation, fetches and installs it (4).
step M "mica-deploy --max-bytes 536870912 set-check --kind core --source http://10.0.2.2:8000/update/ --channel general | grep -F '\"selected\":null' >/dev/null || fail 'the general line offered a set the device holds'
follow lts
bus CheckUpdate || fail 'update check'
bus_wait '\"deploymentId\":\"$l1\",\"kind\":\"set\",\"setKind\":\"core\"' 'the check did not offer the lts set'
bus FetchUpdate || fail 'update fetch'
bus_wait '\"stagedKind\":\"set\"' 'the fetch did not stage the lts set'
bus InstallUpdate s $l1 || fail 'update install'
for n in \$(seq 1 120); do core_status; core_is pending $l1 && break; sleep 1; done
core_is pending $l1 || fail 'the lts set is not pending'
echo \"FILE_AB_STEP_PASS: M over \$booted\""
pass M

# N: l1 on trial and committed, the device on lts; micad then takes the product line's d5 (4).
step N "wait_current $l1
status_has '\"channel\":\"lts\"' || fail 'the device does not report the lts channel'
grep -F 'core-set=lts-1' /usr/share/doc/micad/core-proof >/dev/null || fail 'the micad composed is not the lts set'\"'\"'s'
bus CheckUpdate || fail 'update check'
bus_wait '\"deploymentId\":\"$d5\",\"kind\":\"deployment\"' 'the check did not offer the served deployment'
bus FetchUpdate || fail 'update fetch'
bus_wait '\"stagedKind\":\"deployment\"' 'the fetch did not stage the served deployment'
bus InstallUpdate s $d5 || fail 'update install'
for n in \$(seq 1 120); do mica-deploy status | grep -F '\"candidate\":\"$d5\"' >/dev/null && break; sleep 1; done
mica-deploy status | grep -F '\"candidate\":\"$d5\"' >/dev/null || fail 'the served deployment is not the candidate'
echo \"FILE_AB_STEP_PASS: N over \$booted\""
expect "$out/N.log" "mica-init: core set $l1 (lts generation 1), on trial"
pass N

# P: d5 boots on l1.
step P "[ \"\$booted\" = $d5 ] || fail \"booted \$booted, not the served deployment $d5\"
core_status
core_is current $l1 || fail 'the system update moved the core set'
echo \"FILE_AB_STEP_PASS: P over \$booted\""
expect "$out/P.log" "mica-init: core set $l1 (lts generation 1)"
pass P

# R: l2 goes pending, then loses a component (7).
step R "import_set lts-2
install_set $l2 || fail 'core set installation'
drop_component $(micad_of lts-2)
echo \"FILE_AB_STEP_PASS: R over \$booted\""
pass R

# S1-S3: the incomplete set is passed over, l1 composed and healthy at every boot; its trial spent, it is dropped (7).
for attempt in 1 2 3; do
    step "S$attempt" "grep -F 'core-set=lts-1' /usr/share/doc/micad/core-proof >/dev/null || fail 'the boot did not compose the current set'
core_status
echo \"FILE_AB_STEP_PASS: S$attempt over \$booted\""
    expect "$out/S$attempt.log" "mica-init: core set $l1 (lts generation 1)"
    refute "$out/S$attempt.log" "mica-init: core set $l2"
    pass "S$attempt"
done

# T: the incomplete set is gone; the current set loses a component (7).
step T "wait_current $l1
drop_component $(micad_of lts-1)
echo \"FILE_AB_STEP_PASS: T over \$booted\""
pass T

# U: a current set that cannot be composed stops the boot (7).
step U "echo \"FILE_AB_STEP_PASS: U over \$booted\""
expect "$out/U.log" 'mica-init: boot refused'
refute "$out/U.log" FILE_AB_RUNTIME_PASS

rm -rf "$evidence/offline" "$evidence/www"
echo "CORE_SETS_PASS: scenarios 1 to 7"
