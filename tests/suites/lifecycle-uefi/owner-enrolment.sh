#!/bin/bash
# Owner certificates and driver extension archives (mica-core:docs/mica-core.md 6.3 "Driver extensions" and "Owner
# certificates", 6.5), over the runtime image a product already booted and confirmed. One boot per step; each step's
# media (runtime.sh's actions hook) carries what the guest does and checks, and the host reads the console.
# Scenarios:
#   1  a certificate enrolled with owner-cert-add stands pending-next-boot, in the audit, and is loaded at the next
#      boot; an archive for the running kernel (extension-import) is installed and mapped               (A, B)
#   2  an archive for the kernel of the system a check selected stays staged, and that system's install takes it:
#      the update maps it                                                                               (C, D)
#   3  extension-drop stages the next kernel's running without it, and the update installs without     (E, F)
#   4  that kernel's signed policy asks for certificates to be confirmed on the console: a boot with no key
#      press loads none and they stand pending-confirmation; a boot with Enter pressed loads both and records them;
#      the next boot asks nothing                                                                       (F, G, H)
#
#   bash tests/suites/lifecycle-uefi/owner-enrolment.sh <runtime evidence> <cert> <key> <runkit> <board> <BSP kernel>
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
out="$evidence/owner-enrolment"
rm -rf "$out" "$evidence/www"
mkdir -p "$out"
kernel_of() { sed -n 's/.*"id":"\([0-9a-f]\{64\}\)".*/\1/p' "$1" | head -n 1; }
k1=$(kernel_of "$evidence/kernel/kernel.json")
grep -F '"driver-ext"' "$evidence/kernel/kernel.json" >/dev/null || { echo "error: the kernel component does not claim driver-ext" >&2; exit 1; }

deployment_of() {
    # A kernel update from update.ts, moved out of the evidence root where the default flow would install it.
    timeout 900s bun tests/suites/lifecycle-uefi/update.ts "$evidence" "$certificate" "$key" "$1" "$2" "$evidence/root" "$evidence/kernel" "$runkit" >&2
    mv "$evidence/offline" "$out/deploy-$1"
}
deployment_of 3 kernel
deployment_of 4 kernel-confirm
d3=$(cat "$out/deploy-3/expected-id") d4=$(cat "$out/deploy-4/expected-id")
k2=$(kernel_of "$evidence/updates/3/kernel/kernel.json") k3=$(kernel_of "$evidence/updates/4/kernel/kernel.json")
[ -n "$k2" ] && [ -n "$k3" ] && [ "$k2" != "$k1" ] && [ "$k3" != "$k2" ] || { echo "error: the kernel updates do not change the kernel ($k1 $k2 $k3)" >&2; exit 1; }
timeout 900s bun tests/suites/lifecycle-uefi/enrolment-extensions.ts "$bsp" "$out/ext" "$k1" "$k2" >&2
# The catalog a check reads: the product line offers d3, whose root the device already holds.
timeout 600s bun tests/suites/lifecycle-uefi/core-catalog.ts "$evidence/www/update" http://10.0.2.2:8000/update/ \
    --product "$out/deploy-3" --objects "$evidence/root" >&2
sha() { sha256sum "$1" | cut -d' ' -f1; }
ca=$(sha "$out/ext/owner-ca.der") second=$(sha "$out/ext/second-ca.der")
hello1=$(sha "$out/ext/hello-$k1/ext.json") hello2=$(sha "$out/ext/hello-$k2/ext.json")
echo "kernels: k1 $k1, k2 $k2 (d3 $d3), k3 $k3 (d4 $d4, confirmation on); certificates: owner $ca, second $second"

cat >"$out/lib.sh" <<'LIB'
# Guest helpers for owner-enrolment.sh steps.
m=/run/mica/import
state=/mnt/system/extensions/state.json
show() {
    echo "trust: $(cat /run/mica/trust.json 2>&1)"; echo "extensions: $(cat /run/mica/extensions.json 2>&1)"
    echo "owner-certs: $(mica-deploy owner-certs 2>&1)"; echo "state: $(cat $state 2>&1)"
}
# stands <sha256> <state>: owner-certs says where that certificate stands against this boot.
stands() { mica-deploy owner-certs | grep -E "\"sha256\":\"$1\"[^}]*\"state\":\"$2\"|\"state\":\"$2\"[^}]*\"sha256\":\"$1\"" >/dev/null; }
# trusted <sha256> <state>: the runkit's record of it at this boot.
trusted() { grep -E "\"sha256\":\"$1\",\"state\":\"$2\"" /run/mica/trust.json >/dev/null; }
mapped() { grep -E "\"id\":\"$1\"[^}]*\"state\":\"mapped\"" /run/mica/extensions.json >/dev/null; }
loaded() {
    for _ in $(seq 1 30); do grep -q '^hello ' /proc/modules && break; sleep 1; done
    grep -q '^hello ' /proc/modules || fail 'the extension module hello did not load at boot'
}
settled() {
    ! grep -F -e '"pending"' -e '"pair"' $state >/dev/null || fail "$1: a change is still pending: $(cat $state)"
}
install_deploy() { d=$1; shift; mica-deploy install "$m/deploy-$d/deployment.json" --objects "$m/deploy-$d/objects" "$@"; }
LIB
# step <name> <actions> [env]: the media for one boot (lib.sh, actions.sh, the inputs), then the boot.
step() {
    local name=$1 actions=$2 env=${3:-CONSOLE_ENTER=}
    rm -rf "$evidence/offline"
    mkdir -p "$evidence/offline"
    cp -r "$out/lib.sh" "$out/ext" "$out/deploy-3" "$out/deploy-4" "$evidence/offline/"
    printf '. /run/mica/import/lib.sh\n%s\n' "$actions" >"$evidence/offline/actions.sh"
    docker run --rm --label ai-agent=true --network traefik -e "$env" -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 400 "$arch" >"$out/$name.log" 2>&1 || true
    rm -rf "$evidence/offline"
    echo "step $name: $(grep -a -E 'mica-init: (owner|selected|driver extension)|FILE_AB_STEP_PASS|FILE_AB_RUNTIME_FAIL' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
    grep -aF "FILE_AB_STEP_PASS: $name" "$out/$name.log" >/dev/null && grep -aF FILE_AB_RUNTIME_PASS "$out/$name.log" >/dev/null ||
        { echo "error: step $name failed; see $out/$name.log" >&2; grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$name.log" >&2 || true; exit 1; }
}
prompts() { grep -ac 'press Enter on this console' "$out/$1.log" || true; }

# A: the owner CA enrolled with owner-cert-add, and hello for the running kernel imported from its archive (1).
step A "r=\$(mica-deploy owner-cert-add \$m/ext/owner-ca.der --by cli --source lifecycle-uefi 2>&1) || fail \"owner-cert-add: \$r\"
echo \"owner-cert-add: \$r\"
echo \"\$r\" | grep -F '\"sha256\":\"$ca\"' >/dev/null && echo \"\$r\" | grep -F '\"applies\":\"next-boot\"' >/dev/null || fail 'owner-cert-add did not answer the certificate for the next boot'
stands $ca pending-next-boot || fail \"the enrolled CA does not stand pending-next-boot: \$(mica-deploy owner-certs)\"
echo \"audit: \$(cat /mnt/system/owner-certs/audit.json)\"
grep -E '\"change\":\"add\"[^}]*\"sha256\":\"$ca\"|\"sha256\":\"$ca\"[^}]*\"change\":\"add\"' /mnt/system/owner-certs/audit.json >/dev/null || fail 'the audit does not record the add'
grep -F '\"by\":\"cli\"' /mnt/system/owner-certs/audit.json >/dev/null || fail 'the audit does not record who added it'
r=\$(mica-deploy extension-import \$m/ext/hello-$k1/ext.micaupd 2>&1) || fail \"extension-import: \$r\"
echo \"extension-import: \$r\"
echo \"\$r\" | grep -F '\"staged\":false' >/dev/null && echo \"\$r\" | grep -F '\"extensionId\":\"$hello1\"' >/dev/null || fail 'the archive for the running kernel was not installed'
s=\$(mica-deploy status) || fail status
echo \"status: \$s\"
echo \"\$s\" | grep -F '\"pendingVerification\":' | grep -F $hello1 >/dev/null || fail 'status does not name hello as pending verification'
echo 'FILE_AB_STEP_PASS: A'"

# B: the CA loaded, hello mapped and committed (1).
step B "show
trusted $ca loaded || fail 'the enrolled CA was not loaded'
stands $ca loaded || fail 'owner-certs does not say the CA is loaded'
mapped $hello1 || fail 'hello is not mapped'
loaded
settled 'the imported build'
grep -F '\"$k1\":{\"hello\":\"$hello1\"}' \$state >/dev/null || fail 'hello is not the confirmed build'
echo 'FILE_AB_STEP_PASS: B'"

# C: a check selects d3, which waits for hello; its archive is staged, not installed, and d3's install takes it (2).
step C "r=\$(mica-deploy --max-bytes 536870912 check --source http://10.0.2.2:8000/update/ 2>&1) || fail \"check: \$r\"
echo \"check: \$r\"
echo \"\$r\" | grep -F $d3 >/dev/null || fail 'the check did not select d3'
mica-deploy status | grep -F '\"waitsForExtension\":[{' | grep -F hello >/dev/null || fail \"status does not say d3 waits for hello: \$(mica-deploy status)\"
r=\$(mica-deploy extension-import \$m/ext/hello-$k2/ext.micaupd 2>&1) || fail \"extension-import: \$r\"
echo \"extension-import: \$r\"
echo \"\$r\" | grep -F '\"staged\":true' >/dev/null || fail 'the archive for the selected system was not staged'
! grep -F $hello2 \$state >/dev/null || fail 'the staged build was installed before its system'
r=\$(install_deploy 3 2>&1) || fail \"the install of d3 with hello staged: \$r\"
echo \"install: \$r\"
show
grep -F '\"pair\":\"$d3\"' \$state >/dev/null && grep -F $hello2 \$state >/dev/null || fail 'd3 was not installed with the staged hello'
echo 'FILE_AB_STEP_PASS: C'"

# D: d3 boots with hello mapped as its pair, both committed (2).
step D "show
[ \"\$booted\" = $d3 ] || fail \"booted \$booted, not d3\"
mapped $hello2 || fail 'the staged hello is not mapped'
grep -E '\"trial\":\\{[^}]*\"paired\":true' /run/mica/extensions.json >/dev/null || fail 'hello was not mapped as the pair of d3'
loaded
settled 'the update with the staged build'
grep -F '\"$k2\":{\"hello\":\"$hello2\"}' \$state >/dev/null || fail 'the staged hello is not confirmed'
echo 'FILE_AB_STEP_PASS: D'"

# E: d4 runs without hello: extension-drop stages it, and the install takes the drop (3).
step E "if r=\$(install_deploy 4 2>&1); then fail \"d4 installed without a build or a drop of hello: \$r\"; fi
echo \"\$r\" | grep -F 'waitsForExtension:' >/dev/null || fail \"d4 was refused for another reason: \$r\"
r=\$(mica-deploy extension-drop hello --kernel $k3 2>&1) || fail \"extension-drop: \$r\"
echo \"extension-drop: \$r\"
r=\$(install_deploy 4 2>&1) || fail \"the install of d4 with the drop staged: \$r\"
echo \"install: \$r\"
show
grep -F '\"pair\":\"$d4\"' \$state >/dev/null || fail 'd4 was not installed with the drop'
echo 'FILE_AB_STEP_PASS: E'"

# F: d4's policy asks for confirmation, and nobody presses a key: the CA stays out; a second CA is enrolled (3, 4).
step F "show
[ \"\$booted\" = $d4 ] || fail \"booted \$booted, not d4\"
! grep -q '^hello ' /proc/modules || fail 'hello loaded on the kernel that runs without it'
settled 'the update without hello'
trusted $ca unconfirmed || fail 'the CA was trusted without a confirmation'
stands $ca pending-confirmation || fail 'owner-certs does not say the CA waits for a confirmation'
[ ! -e /mnt/data/meta/owner-confirmed.json ] || fail \"a confirmation was recorded: \$(cat /mnt/data/meta/owner-confirmed.json)\"
r=\$(mica-deploy owner-cert-add \$m/ext/second-ca.der --by cli --source lifecycle-uefi 2>&1) || fail \"owner-cert-add: \$r\"
echo \"owner-cert-add: \$r\"
echo 'FILE_AB_STEP_PASS: F'"
[ "$(prompts F)" = 1 ] || { echo "error: F asked $(prompts F) times, not once for the CA" >&2; exit 1; }

# G: Enter is pressed at each question: both certificates are loaded and their confirmation recorded (4).
step G "show
trusted $ca loaded || fail 'the confirmed CA was not loaded'
trusted $second loaded || fail 'the confirmed second CA was not loaded'
stands $ca loaded && stands $second loaded || fail 'owner-certs does not say both are loaded'
echo \"confirmed: \$(cat /mnt/data/meta/owner-confirmed.json)\"
grep -F $ca /mnt/data/meta/owner-confirmed.json >/dev/null && grep -F $second /mnt/data/meta/owner-confirmed.json >/dev/null || fail 'the confirmations were not recorded'
echo 'FILE_AB_STEP_PASS: G'" CONSOLE_ENTER=1
[ "$(prompts G)" = 2 ] || { echo "error: G asked $(prompts G) times, not once for each certificate" >&2; exit 1; }
grep -aF "owner certificate $ca confirmed" "$out/G.log" >/dev/null && grep -aF "owner certificate $second confirmed" "$out/G.log" >/dev/null ||
    { echo "error: G did not confirm both certificates on the console" >&2; exit 1; }

# H: the next boot asks nothing and loads both (4).
step H "trusted $ca loaded && trusted $second loaded || fail \"the confirmed certificates were not loaded again: \$(cat /run/mica/trust.json)\"
echo 'FILE_AB_STEP_PASS: H'"
[ "$(prompts H)" = 0 ] || { echo "error: H asked again for a confirmed certificate" >&2; exit 1; }
echo "OWNER_ENROLMENT_PASS: owner-cert-add enrolled and loaded, archives installed or staged for the selected system and taken by its update, a drop taken by the next, console confirmation refused without a key press and loaded with one"
