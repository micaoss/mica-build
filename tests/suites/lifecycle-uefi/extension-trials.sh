#!/bin/bash
# Driver extension changes on trial (mica-core:docs/mica-core.md 6.3 "Driver extensions" and "A new kernel waits for
# its extensions"), over the runtime image a product already booted and confirmed. One boot per step; each step's
# media (runtime.sh's actions hook) carries what the guest installs and checks, and the host reads the console.
# Scenarios:
#   1  a change for the running kernel goes on a trial of its own (3 boots), the next boot maps it as that trial
#      (unpaired) and the health gate's confirm commits it                                           (A, B)
#   2  a change whose boots never come up: its three boots spent, the fourth maps the confirmed build and confirm
#      drops the change                                                                              (C, D1-D3, E)
#   3  a kernel update waits for the extension; --extension pairs a build with the new deployment, which maps it on
#      its trial and commits it; a further kernel update with --drop-extension runs without it       (F, G, H, I)
#
#   bash tests/suites/lifecycle-uefi/extension-trials.sh <runtime evidence> <cert> <key> <runkit> <board> <BSP kernel>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
certificate=${2:?public content certificate required}
key=${3:?external content key required}
runkit=${4:?compiled mica-runkit required}
board=${5:?board required}
bsp=${6:?BSP kernel directory required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test ! -e "$evidence/offline"
out="$evidence/extension-trials"
rm -rf "$out"
mkdir -p "$out"
kernel_of() { sed -n 's/.*"id":"\([0-9a-f]\{64\}\)".*/\1/p' "$1" | sed -n 1p; }
k1=$(kernel_of "$evidence/kernel/kernel.json")
grep -F '"driver-ext"' "$evidence/kernel/kernel.json" >/dev/null || { echo "error: the kernel component does not claim driver-ext" >&2; exit 1; }

deployment_of() {
    # A kernel update from update.ts, moved out of the evidence root where the default flow would install it.
    timeout 900s bun tests/suites/lifecycle-uefi/update.ts "$evidence" "$certificate" "$key" "$1" kernel "$evidence/root" "$evidence/kernel" "$runkit" >&2
    mv "$evidence/offline" "$out/deploy-$1"
}
deployment_of 3
deployment_of 4
d3=$(cat "$out/deploy-3/expected-id") d4=$(cat "$out/deploy-4/expected-id")
k2=$(kernel_of "$evidence/updates/3/kernel/kernel.json") k3=$(kernel_of "$evidence/updates/4/kernel/kernel.json")
[ -n "$k2" ] && [ -n "$k3" ] && [ "$k2" != "$k1" ] && [ "$k3" != "$k2" ] || { echo "error: the kernel updates do not change the kernel ($k1 $k2 $k3)" >&2; exit 1; }
grep -F '"driver-ext"' "$evidence/updates/3/kernel/kernel.json" >/dev/null || { echo "error: the updated kernel does not claim driver-ext" >&2; exit 1; }
timeout 900s bun tests/suites/lifecycle-uefi/trial-extensions.ts "$bsp" "$out/ext" "$k1" "$k2" >&2
# The paired build travels in the update's objects, by digest.
for f in ext.img ext.roothash.p7s; do
    cp "$out/ext/hello-$k2/$f" "$out/deploy-3/objects/$(sha256sum "$out/ext/hello-$k2/$f" | cut -d' ' -f1)"
done
ext_id() { sha256sum "$out/ext/$1/ext.json" | cut -d' ' -f1; }
echo "kernels: k1 $k1, k2 $k2 (d3 $d3), k3 $k3 (d4 $d4)"

cat >"$out/lib.sh" <<'LIB'
# Guest helpers for extension-trials.sh steps.
m=/run/mica/import
state=/mnt/system/extensions/state.json
show() { echo "extensions: $(cat /run/mica/extensions.json 2>&1)"; echo "state: $(cat $state 2>&1)"; echo "trial: $(cat /mnt/data/meta/set-trial.json 2>&1)"; }
# mapped <extension id>: this boot mapped hello from that build.
mapped() { grep -E "\"id\":\"$1\"[^}]*\"state\":\"mapped\"|\"state\":\"mapped\"[^}]*\"id\":\"$1\"" /run/mica/extensions.json >/dev/null; }
loaded() {
    for _ in $(seq 1 30); do grep -q '^hello ' /proc/modules && break; sleep 1; done
    grep -q '^hello ' /proc/modules || fail 'the extension module hello did not load at boot'
    case "$(modinfo -n hello)" in */updates/mica-ext/hello/hello.ko) ;; *) fail "hello loaded from $(modinfo -n hello)" ;; esac
}
settled() {
    ! grep -F '"pending"' $state >/dev/null || fail "$1: a change is still pending: $(cat $state)"
    ! grep -F '"pair"' $state >/dev/null || fail "$1: a pair is still named: $(cat $state)"
    [ ! -e /mnt/data/meta/set-trial.json ] || fail "$1: the trial outlived the confirm: $(cat /mnt/data/meta/set-trial.json)"
}
install_deploy() { d=$1; shift; mica-deploy install "$m/deploy-$d/deployment.json" --objects "$m/deploy-$d/objects" "$@"; }
LIB
# step <name> <actions>: the media for one boot (lib.sh, actions.sh, the extensions and deployments), then the boot.
step() {
    local name=$1 actions=$2
    rm -rf "$evidence/offline"
    mkdir -p "$evidence/offline"
    cp -r "$out/lib.sh" "$out/ext" "$out/deploy-3" "$out/deploy-4" "$evidence/offline/"
    printf '. /run/mica/import/lib.sh\n%s\n' "$actions" >"$evidence/offline/actions.sh"
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 400 "$arch" >"$out/$name.log" 2>&1 || true
    rm -rf "$evidence/offline"
    echo "step $name: $(grep -a -E 'mica-init: (driver extension|owner|selected)|mica hello|FILE_AB_STEP_PASS|FILE_AB_RUNTIME_FAIL' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
}
pass() {
    grep -aF "FILE_AB_STEP_PASS: $1" "$out/$1.log" >/dev/null && grep -aF FILE_AB_RUNTIME_PASS "$out/$1.log" >/dev/null ||
        { echo "error: step $1 failed; see $out/$1.log" >&2; grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$1.log" >&2 || true; exit 1; }
}
hello=$(ext_id hello) crash=$(ext_id crash) hello2=$(ext_id "hello-$k2")

# A: the owner CA enrolled, hello installed for the running kernel: a change alone, three boots (1).
step A "mount -o remount,rw /mnt/system || fail 'SYSTEM read-write for the enrolment'
mkdir -p /mnt/system/owner-certs || fail 'owner-certs/ on SYSTEM'
cp \$m/ext/owner-ca.der /mnt/system/owner-certs/\$(sha256sum \$m/ext/owner-ca.der | cut -d' ' -f1).der || fail 'enrolling the owner CA'
sync
mount -o remount,ro /mnt/system || fail 'SYSTEM back to read-only'
r=\$(mica-deploy extension-install \$m/ext/hello/ext.json --objects \$m/ext/hello 2>&1) || fail \"extension-install hello: \$r\"
echo \"install hello: \$r\"
s=\$(mica-deploy status) || fail 'status'
echo \"status: \$s\"
echo \"\$s\" | grep -F '\"attemptsLeft\":3' >/dev/null || fail 'the change alone has not three boots'
grep -F '\"pending\"' \$state >/dev/null || fail 'the installed extension is not a pending change'
! grep -F '\"pair\"' \$state >/dev/null || fail 'a change for the running kernel is paired'
grep -F '\"kind\":\"extensions\"' /mnt/data/meta/set-trial.json >/dev/null || fail \"no extensions trial: \$(cat /mnt/data/meta/set-trial.json 2>&1)\"
echo 'FILE_AB_STEP_PASS: A'"
pass A

# B: the trial boot maps hello as the unpaired trial, the health gate's confirm commits it (1).
step B "show
grep -E '\"trial\":\\{[^}]*\"paired\":false' /run/mica/extensions.json >/dev/null || fail 'the boot did not map the change as its own trial'
mapped $hello || fail 'hello 1.0 is not mapped'
loaded
settled 'the committed change'
grep -F '\"$k1\":{\"hello\":\"$hello\"}' \$state >/dev/null || fail 'hello 1.0 is not the confirmed build'
echo 'FILE_AB_STEP_PASS: B'"
pass B

# C: hello 2.0, whose load restarts the machine, goes on trial (2).
step C "r=\$(mica-deploy extension-install \$m/ext/crash/ext.json --objects \$m/ext/crash 2>&1) || fail \"extension-install hello 2.0: \$r\"
echo \"install hello 2.0: \$r\"
mica-deploy status | grep -F '\"attemptsLeft\":3' >/dev/null || fail 'the change has not three boots'
grep -F '\"$crash\"' \$state >/dev/null || fail 'hello 2.0 is not the pending change'
echo 'FILE_AB_STEP_PASS: C'"
pass C

# D1-D3: its three boots; each maps the change and restarts as the module loads (2).
for attempt in 1 2 3; do
    step "D$attempt" "fail 'a boot of the crashing change came up'"
    grep -aF 'mica hello: restarting the machine' "$out/D$attempt.log" >/dev/null || { echo "error: boot D$attempt did not load hello 2.0; see $out/D$attempt.log" >&2; exit 1; }
    ! grep -aF FILE_AB_RUNTIME_PASS "$out/D$attempt.log" >/dev/null || { echo "error: boot D$attempt came up" >&2; exit 1; }
done

# E: the trial spent, the fourth boot maps the confirmed hello 1.0; confirm drops the change (2).
step E "show
! grep -F '\"trial\"' /run/mica/extensions.json >/dev/null || fail 'the spent change was mapped again'
mapped $hello || fail 'the confirmed hello 1.0 is not mapped'
loaded
dmesg | grep -c 'mica hello: loaded' >/dev/null || fail 'hello 1.0 did not run its init'
settled 'the spent change'
grep -F '\"$k1\":{\"hello\":\"$hello\"}' \$state >/dev/null || fail 'the confirmed build changed'
mica-deploy status | grep -F \"\\\"current\\\":\\\"\$booted\\\"\" >/dev/null || fail 'the spent change retired the deployment'
echo 'FILE_AB_STEP_PASS: E'"
pass E
deployment=$(sed -n 's/.*selected deployment \([0-9a-f]\{64\}\).*/\1/p' "$out/E.log" | tr -d '\r' | tail -n 1)

# F: the kernel update waits for hello; --extension pairs hello for its kernel with it (3).
step F "if r=\$(install_deploy 3 2>&1); then fail \"a kernel update without hello was installed: \$r\"; fi
echo \"refused: \$r\"
echo \"\$r\" | grep -F 'waitsForExtension:' >/dev/null && echo \"\$r\" | grep -F hello >/dev/null || fail \"the refusal does not wait for hello: \$r\"
r=\$(install_deploy 3 --extension \$m/ext/hello-$k2/ext.json 2>&1) || fail \"paired install: \$r\"
echo \"install: \$r\"
show
grep -F '\"pair\":\"$d3\"' \$state >/dev/null || fail 'the change is not paired with the update'
grep -F '\"$hello2\"' \$state >/dev/null || fail 'the paired change has not hello for the new kernel'
echo 'FILE_AB_STEP_PASS: F'"
pass F

# G: the update boots with its pair mapped, on its trial; confirm commits both (3).
step G "show
[ \"\$booted\" = $d3 ] || fail \"booted \$booted, not the kernel update $d3\"
grep -E '\"trial\":\\{[^}]*\"paired\":true' /run/mica/extensions.json >/dev/null || fail 'the update did not map its pair'
mapped $hello2 || fail 'hello for the new kernel is not mapped'
loaded
settled 'the committed pair'
grep -F '\"$k2\":{\"hello\":\"$hello2\"}' \$state >/dev/null || fail 'hello for the new kernel is not confirmed'
echo 'FILE_AB_STEP_PASS: G'"
pass G
grep -aF "selected deployment $d3" "$out/G.log" >/dev/null || { echo "error: G did not boot $d3" >&2; exit 1; }

# H: a further kernel update waits for hello too, and --drop-extension lets it run without (3).
step H "if r=\$(install_deploy 4 2>&1); then fail \"a kernel update without hello was installed: \$r\"; fi
echo \"\$r\" | grep -F 'waitsForExtension:' >/dev/null || fail \"the refusal does not wait for hello: \$r\"
r=\$(install_deploy 4 --drop-extension hello 2>&1) || fail \"install --drop-extension: \$r\"
echo \"install: \$r\"
show
grep -F '\"pair\":\"$d4\"' \$state >/dev/null || fail 'the drop is not paired with the update'
echo 'FILE_AB_STEP_PASS: H'"
pass H

# I: the update boots without hello; confirm commits it with no build for its kernel (3).
step I "show
[ \"\$booted\" = $d4 ] || fail \"booted \$booted, not the kernel update $d4\"
! mapped $hello2 || fail 'hello was mapped on the kernel that runs without it'
! grep -q '^hello ' /proc/modules || fail 'hello loaded on the kernel that runs without it'
settled 'the committed drop'
! grep -F '\"$k3\":{\"hello\"' \$state >/dev/null || fail 'the dropped extension has a build for the new kernel'
echo 'FILE_AB_STEP_PASS: I'"
pass I
echo "EXTENSION_TRIALS_PASS: a change alone tried and committed, a spent change dropped for the confirmed build, a kernel update paired with its build and one run without it (over $deployment)"
