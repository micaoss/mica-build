#!/bin/bash
# Driver extensions and the owner keyring on a device (mica-core:docs/mica-core.md, Driver extensions and 6.5), over
# the runtime image a product already booted. Three boots, each running the runtime suite with this step's
# actions.sh on the offline media (runtime.sh), `booted` and `fail` in scope:
#   install  an owner CA enrolled on SYSTEM (owner-certs/<sha256>.der, as the enrolment API will write it) and two
#            extensions installed for the booted kernel: hello by that owner, other by an owner never enrolled;
#   mapped   the runkit loaded the CA and sealed, mapped hello, whose module loads from updates/mica-ext/, refused
#            other; then a factory reset is staged;
#   reset    the reset's finish removed extensions/ and owner-certs/: nothing enrolled, nothing mapped.
#
#   bash tests/suites/lifecycle-uefi/extensions.sh <runtime evidence> <board> <BSP kernel directory>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
board=${2:?board required}
kernel=${3:?BSP kernel directory required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
test ! -e "$evidence/offline"
out="$evidence/extensions"
rm -rf "$out"
mkdir -p "$out"
kernel_id=$(sed -n 's/.*"id":"\([0-9a-f]\{64\}\)".*/\1/p' "$evidence/kernel/kernel.json" | sed -n 1p)
[ -n "$kernel_id" ] || { echo "error: no kernel id in $evidence/kernel/kernel.json" >&2; exit 1; }
grep -F '"driver-ext"' "$evidence/kernel/kernel.json" >/dev/null || { echo "error: the kernel component does not claim driver-ext; extension-install would refuse" >&2; exit 1; }
timeout 900s bun tests/suites/lifecycle-uefi/owner-extensions.ts "$kernel" "$kernel_id" "$out/ext" >&2

step() {
    local name=$1 actions=$2
    rm -rf "$evidence/offline"
    mkdir -p "$evidence/offline"
    cp -r "$out/ext/hello" "$out/ext/other" "$out/ext/owner-ca.der" "$evidence/offline/"
    printf '%s\n' "$actions" >"$evidence/offline/actions.sh"
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 400 "$arch" >"$out/$name.log" 2>&1 || true
    rm -rf "$evidence/offline"
    grep -aF "FILE_AB_STEP_PASS: $name" "$out/$name.log" >/dev/null && grep -aF FILE_AB_RUNTIME_PASS "$out/$name.log" >/dev/null ||
        { echo "error: step $name failed; see $out/$name.log" >&2; grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$name.log" >&2 || true; exit 1; }
    echo "step $name: $(grep -a -E 'mica-init: (extension|factory reset|owner)|FILE_AB_STEP_PASS' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
}

step install "$(cat <<'ACTIONS'
m=/run/mica/import
grep -F '"ownerKeyring":"sealed"' /run/mica/trust.json >/dev/null || fail "the runkit did not seal the owner keyring: $(cat /run/mica/trust.json 2>&1)"
# SYSTEM is mounted read-only; until the enrolment API (E3) the suite writes the file as it will, read-write briefly.
mount -o remount,rw /mnt/system || fail 'SYSTEM read-write for the enrolment'
mkdir -p /mnt/system/owner-certs || fail 'owner-certs/ on SYSTEM'
cp "$m/owner-ca.der" "/mnt/system/owner-certs/$(sha256sum "$m/owner-ca.der" | cut -d' ' -f1).der" || fail 'enrolling the owner CA on SYSTEM'
sync
mount -o remount,ro /mnt/system || fail 'SYSTEM back to read-only'
for e in hello other; do
    r=$(mica-deploy extension-install "$m/$e/ext.json" --objects "$m/$e" 2>&1) || fail "extension-install $e: $r"
    echo "install $e: $r"
done
mica-deploy status | grep -F '"extensions":' >/dev/null || fail 'status names no extensions'
sync
echo "FILE_AB_STEP_PASS: install"
ACTIONS
)"

step mapped "$(cat <<'ACTIONS'
echo "trust: $(cat /run/mica/trust.json)"
echo "extensions: $(cat /run/mica/extensions.json)"
grep -F '"ownerKeyring":"sealed"' /run/mica/trust.json >/dev/null || fail 'the owner keyring is not sealed'
grep -E '"state":"loaded"' /run/mica/trust.json >/dev/null || fail 'the enrolled owner CA was not loaded'
grep -E '"name":"hello"[^}]*"state":"mapped"|"state":"mapped"[^}]*"name":"hello"' /run/mica/extensions.json >/dev/null || fail 'hello is not mapped'
grep -E '"name":"other"[^}]*"state":"refused"|"state":"refused"[^}]*"name":"other"' /run/mica/extensions.json >/dev/null || fail 'the extension of an owner never enrolled is not refused'
for _ in $(seq 1 30); do grep -q '^hello ' /proc/modules && break; sleep 1; done
grep -q '^hello ' /proc/modules || fail 'the extension module hello did not load at boot'
path=$(modinfo -n hello) || fail 'modinfo hello'
case "$path" in */updates/mica-ext/hello/hello.ko) ;; *) fail "hello loaded from $path, not from updates/mica-ext/" ;; esac
grep -E '^updates/mica-ext/hello/hello\.ko:' "/usr/lib/modules/$(uname -r)/modules.dep" >/dev/null || fail "modules.dep does not name hello under updates/mica-ext/: $(grep -F hello "/usr/lib/modules/$(uname -r)/modules.dep")"
dmesg | grep -c 'mica hello: loaded' >/dev/null || fail 'hello loaded without running its init'
! grep -q '^hello_other ' /proc/modules || fail 'the module of an owner never enrolled loaded'
r=$(mica-deploy factory-reset --by cli --source lifecycle-uefi 2>&1) || fail "staging the factory reset: $r"
echo "FILE_AB_STEP_PASS: mapped"
ACTIONS
)"

step reset "$(cat <<'ACTIONS'
echo "trust: $(cat /run/mica/trust.json)"
echo "extensions: $(cat /run/mica/extensions.json 2>&1)"
[ -z "$(ls -A /mnt/system/owner-certs 2>/dev/null)" ] || fail "the factory reset left owner certificates: $(ls /mnt/system/owner-certs)"
[ -z "$(ls -A /mnt/system/extensions/objects 2>/dev/null)" ] || fail "the factory reset left extensions: $(ls /mnt/system/extensions/objects)"
grep -F '"ownerKeyring":"sealed"' /run/mica/trust.json >/dev/null || fail 'the reset boot did not seal the owner keyring'
grep -F '"ownerCerts":[]' /run/mica/trust.json >/dev/null || fail 'a certificate was enrolled at the factory reset boot'
grep -F 'skipped' /run/mica/extensions.json >/dev/null || fail "the reset boot did not skip the extensions: $(cat /run/mica/extensions.json 2>&1)"
[ ! -e /mnt/system/extensions ] || [ -z "$(ls -A /mnt/system/extensions/objects 2>/dev/null)" ] || fail 'extensions/ survived the finish'
! grep -q '^hello ' /proc/modules || fail 'the extension module loaded after the factory reset'
echo "FILE_AB_STEP_PASS: reset"
ACTIONS
)"
echo "EXTENSIONS_PASS: owner CA enrolled and loaded, hello mapped and loaded from updates/mica-ext, other refused, factory reset removed both"
