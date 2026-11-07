#!/bin/sh
# Observe the full production services and writable namespace policy in QEMU.
set -eu
exec >/dev/console 2>&1
. /usr/lib/mica/test-init.sh
# A boot with a core set on trial is the health gate's to judge: under systemd this script can fail while the gate
# is still running, and its verdict -- mica-boot-failure's answer, which then restarts the machine itself -- has to
# reach the console before this script powers it off. Under OpenRC this script does not start when micad fails.
await_trial_verdict() {
    [ "$INIT" = systemd ] && [ -e /mnt/data/meta/set-trial.json ] || return 0
    n=0
    while [ "$n" -lt 120 ]; do
        case "$(systemctl is-active mica-health.service)" in
        activating) ;;
        failed) sleep 60; return 0 ;;
        *) return 0 ;;
        esac
        n=$((n + 1))
        sleep 1
    done
}
fail() {
    echo "FILE_AB_RUNTIME_FAIL: $*"
    log_tail 160 mica-data-layout systemd-repart systemd-growfs@mnt-data mica-load-extensions systemd-random-seed mica-health micad apid mica-units
    findmnt -rn -M /mnt/data
    await_trial_verdict
    power_off now
    exit 1
}
storage_measurement() (
    phase=$1
    [ "$phase" = sample ] || sync
    for storage in system esp; do
        case "$storage" in system) mountpoint=/mnt/system; device=vda2;; esp) mountpoint=/boot; device=vda1;; esac
        set -- $(stat -f -c '%b %f %S' "$mountpoint")
        used=$(( ($1 - $2) * $3 ))
        capacity=$(( $1 * $3 ))
        sectors=$(awk '{print $7}' "/sys/class/block/$device/stat")
        echo "FILE_AB_STORAGE: $phase $storage usedBytes=$used capacityBytes=$capacity writtenSectors=$sectors"
    done
)
install_deployment() {
    descriptor=$1
    objects=$2
    if [ -f /run/mica/import/recover-data-write ]; then
        chattr +i /mnt/data/meta/deployments.json || fail 'metadata fault injection'
        if mica-deploy install "$descriptor" --objects "$objects"; then
            chattr -i /mnt/data/meta/deployments.json
            fail 'immutable metadata accepted a state write'
        fi
        chattr -i /mnt/data/meta/deployments.json || fail 'metadata fault removal'
        mica-deploy status | grep -F '"candidate":null' || fail 'incomplete candidate was activated'
        mica-deploy confirm | grep -F "\"current\":\"$booted\"" || fail 'retirement lost the confirmed running deployment'
        mica-deploy install "$descriptor" --objects "$objects" || fail 'replacement retry after DATA repair'
        echo FILE_AB_RETIREMENT_RECOVERY_PASS
    else
        mica-deploy install "$descriptor" --objects "$objects" || fail 'component installation'
    fi
    [ "$(find /mnt/system/deployments -maxdepth 1 -name '*.json' | wc -l)" -eq 2 ] || fail 'SYSTEM must contain exactly two deployment descriptors after installation'
    [ "$(find /boot/loader/entries -maxdepth 1 -name 'mica-*.conf' | wc -l)" -eq 2 ] || fail 'boot entry count exceeds the A/B budget'
    echo FILE_AB_TWO_DEPLOYMENTS_PASS
}
if [ "$INIT" = systemd ]; then
    services="systemd-repart systemd-growfs@mnt-data mica-data-layout mica-seed-state systemd-random-seed systemd-tmpfiles-setup"
else
    services="mica-data-layout mica-mounts mica-dbus mica-network"
fi
# Without micad the base starts the switched-on services itself, mica-units, and checks for updates daily.
if has_micad; then services="$services micad"; else services="$services mica-units"; fi
for service in $services; do
    service_active "$service" || fail "$service is not active"
done
# micad starts apid (its web reconciler, once it holds its bus name; mica-core 2307de0), so apid follows micad by
# a moment rather than being up with it.
if has_micad; then
    waited=0
    until service_active apid; do
        [ "$waited" -lt 60 ] || fail 'apid is not active 60 s after micad, which starts it'
        sleep 1
        waited=$((waited + 1))
    done
fi
if ! has_micad; then
    if [ "$INIT" = systemd ]; then
        systemctl is-enabled --quiet mica-update.timer && systemctl is-active --quiet mica-update.timer ||
            fail 'the daily update timer of a device without micad is not enabled and waiting'
    else
        service_active mica-update || fail 'the daily update of a device without micad is not running'
    fi
    echo FILE_AB_WITHOUT_MICAD_PASS
fi
for path in /mnt/data /mica /mica/containers /srv /var /var/lib/mica; do
    findmnt -rn -M "$path" -o TARGET,SOURCE,FSTYPE,OPTIONS || fail "missing mount $path"
done
# Logical child mounts must never appear in the raw reset backing tree.
awk '$5 ~ /^\/mnt\/data\// { bad=1; print } END { exit bad }' /proc/self/mountinfo \
    || fail 'logical mounts propagated into reset backing storage'
# -p: a boot the health gate rebooted may have left the directory behind.
mkdir -p /mica/containers/mount-proof
mount -t tmpfs -o size=1M tmpfs /mica/containers/mount-proof || fail 'container child mount'
awk '$5 ~ /^\/mnt\/data\// { bad=1; print } END { exit bad }' /proc/self/mountinfo \
    || fail 'container child mount propagated into reset backing storage'
umount /mica/containers/mount-proof
rmdir /mica/containers/mount-proof
echo FILE_AB_MOUNT_ISOLATION_PASS
set -- $(stat -f -c '%b %S' /mnt/data)
[ $(( $1 * $2 )) -gt 1073741824 ] || fail 'DATA did not grow with the medium'
for path in /usr/unlisted /etc/unlisted; do
    if touch "$path" 2>/run/immutable-error; then fail "unexpected writable parent $path"; fi
    grep -c 'Read-only file system' /run/immutable-error >/dev/null || fail "wrong error for $path"
done
for path in /var/unlisted /var/lib/unlisted /var/cache/unlisted /var/log/unlisted; do
    printf 'persistent var\n' >"$path" || fail "var path is not writable: $path"
done
[ "$INIT" != systemd ] || [ -f /var/lib/systemd/var-probe/ready ] || fail 'early StateDirectory service did not run'
if [ -f /var/lib/var-persistence-proof ]; then
    [ "$(cat /var/lib/var-persistence-proof)" = retained ] || fail 'var persistence differs'
    echo FILE_AB_VAR_PERSISTENCE_PASS
else
    printf 'retained\n' >/var/lib/var-persistence-proof
fi
echo FILE_AB_WRITABLE_VAR_PASS
# The service runs as root with the production bounding set.
cap=$(awk '/^CapBnd:/ {print $2}' /proc/self/status)
[ $((0x$cap & (1 << 24))) -eq 0 ] || fail 'CAP_SYS_RESOURCE can bypass quotas'
# The byte and inode limits of a DATA project, as micad reads them (quotactl_fd) and reports them over its bus;
# the runkit sets them when it mounts DATA.
project_limits() {
    project="$(bus GetStorageStatus | tr -d '\\' |
        sed -n "s/.*\"projectQuotas\":{.*\"$1\":{\([^}]*\)}.*/\1/p")"
    [ -n "$project" ] || return 0
    printf '%s %s\n' "$(printf '%s' "$project" | sed -n 's/.*"limitBytes":\([0-9]*\).*/\1/p')" \
        "$(printf '%s' "$project" | sed -n 's/.*"limitInodes":\([0-9]*\).*/\1/p')"
}
if has_micad; then
    set -- $(project_limits 101)
    [ "$#" = 2 ] || fail 'variable project quota missing'
    variable_kib=$(($1 / 1024))
    variable_inodes=$2
    [ "$variable_kib" -ge 32768 ] && [ "$variable_kib" -le 262144 ] || fail 'variable byte quota outside bounds'
    [ "$variable_inodes" -ge 2048 ] && [ "$variable_inodes" -le 16384 ] || fail 'variable inode quota outside bounds'
else
    # Nothing reports the limits without micad; the runkit sets them all the same, so the writes below go past the
    # bounds' upper ends and must meet the quota first.
    variable_kib=262144
    variable_inodes=16384
fi
if dd if=/dev/zero of=/var/tmp/quota-bytes bs=1M count=$((variable_kib / 1024 + 1)) 2>/run/quota-error; then
    fail 'root service bypassed disposable byte quota'
fi
grep -c 'Disk quota exceeded' /run/quota-error >/dev/null || fail 'expected project quota failure'
printf 'state reserve\n' >/mnt/data/state/reserve-proof
printf 'meta reserve\n' >/mnt/data/meta/reserve-proof
rm /var/tmp/quota-bytes
if seq 1 $((variable_inodes + 32)) | sed 's|^|/var/tmp/quota-inode-|' | xargs -n 256 touch 2>/run/quota-error; then
    fail 'root service bypassed variable inode quota'
fi
grep -c 'Disk quota exceeded' /run/quota-error >/dev/null || fail 'root service bypassed inode quota'
printf 'state inode reserve\n' >/mnt/data/state/inode-reserve-proof
find /var/tmp -maxdepth 1 -type f -name 'quota-inode-*' -delete
echo FILE_AB_VAR_QUOTA_PASS
[ "$(stat -c '%d:%i' /mica/containers)" = "$(stat -c '%d:%i' /mnt/data/containers)" ] || fail 'container bind uses the wrong source'
# The container engine is the feature containers: a product without it has the namespace and no podman. A docker
# product's dockerd is off until container.enabled, so its storage is checked once micad starts it (containers.sh).
case " $(sed -n 's/^FEATURES="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /usr/lib/mica/product.conf) :$(sed -n 's/^CONTAINER_ENGINE=//p' /usr/lib/mica/product.conf) " in
*" containers "*" :podman ")
    [ "$(podman info --format '{{.Store.GraphRoot}}')" = /mica/containers/storage ] || fail 'Podman graph root differs'
    [ "$(podman info --format '{{.Store.ImageCopyTmpDir}}')" = /mica/containers/tmp ] || fail 'Podman image downloads escaped the container namespace'
    [ "$(podman info --format '{{.Store.RunRoot}}')" = /run/containers/storage ] || fail 'Podman runtime root differs'
    podman volume create quota-proof >/dev/null || fail 'Podman named volume create'
    volume_path=$(podman volume inspect quota-proof --format '{{.Mountpoint}}')
    case "$volume_path" in /mica/containers/storage/volumes/*/_data) ;; *) fail 'named volume escaped container namespace';; esac
    printf 'named volume write\n' >"$volume_path/proof" || fail 'named volume write'
    podman volume rm quota-proof >/dev/null || fail 'Podman named volume cleanup'
;;
esac
if has_micad; then
    for project in 100 102; do
        [ "$(project_limits "$project")" = '0 0' ] || fail "project $project must have unlimited bytes and inodes"
    done
fi
if [ -f /mica/containers/persistence-proof ]; then
    [ "$(cat /mica/containers/persistence-proof)" = retained ] || fail 'container persistence differs'
    echo FILE_AB_CONTAINER_PERSISTENCE_PASS
else
    printf 'retained\n' >/mica/containers/persistence-proof
fi
echo FILE_AB_UNLIMITED_DATA_PASS

# The app accounts micad keeps on STATE, which runtime-build.sh seeds, are bound over /etc/passwd and /etc/group
# at boot (mica-accounts build: mica-accounts.service, OpenRC's mica-mounts), on either init.
# By name: BusyBox id, a basic root's, takes a user name and no uid.
[ "$(id -u boottest 2>/dev/null)" = 30000 ] && [ "$(id -gn boottest 2>/dev/null)" = boottest ] ||
    fail "the STATE app account boottest (30000) is not bound at boot: id -u boottest says '$(id -u boottest 2>&1)', id -gn boottest '$(id -gn boottest 2>&1)'"
echo FILE_AB_APP_ACCOUNTS_PASS

# The extension units and the random seed on STATE are systemd's.
if [ "$INIT" = systemd ]; then
    [ -e /run/mica/persistent-unit-ran ] || fail 'persistent extension was not loaded at startup'
    seed_inode=$(stat -c %i /mnt/data/state/random-seed)
    systemctl stop systemd-random-seed.service || fail 'random seed shutdown save'
    [ "$(stat -c %i /mnt/data/state/random-seed)" = "$seed_inode" ] || fail 'random seed inode replaced'
    [ "$(stat -c %s /mnt/data/state/random-seed)" -ge 32 ] || fail 'random seed not persisted'
    systemctl start systemd-random-seed.service || fail 'random seed reload'
fi
machine_id=$(cat /etc/machine-id)
[ "$machine_id" = "$(cat /mnt/data/state/machine-id)" ] || fail 'machine identity differs from DATA'
[ "${#machine_id}" -eq 32 ] || fail 'machine identity length'
[ "$(cat /var/lib/dbus/machine-id)" = "$machine_id" ] || fail 'D-Bus identity mismatch'
findmnt -rn -M /etc/machine-id -o OPTIONS | grep -qw ro || fail 'machine identity is writable'
echo "FILE_AB_MACHINE_ID: $machine_id"
# The core components compose over the root at boot (mica-core:docs/mica-core.md 6.5): micad runs from its own
# signed mapping, not from the root.
if has_micad; then
    findmnt -rn -M /run/mica-core/micad >/dev/null || fail 'the micad core component is not mounted'
    [ -x /usr/bin/micad ] || fail 'the micad core component is not composed over /usr'
    echo FILE_AB_CORE_COMPOSED_PASS
fi
booted=$(mica-deploy booted)
confirmed=0
for n in $(seq 1 100); do
    if mica-deploy status | grep -F "\"current\":\"$booted\"" >/dev/null; then confirmed=1; break; fi
    sleep 1
done
[ "$confirmed" = 1 ] || fail 'health did not confirm the deployment'
mica-deploy status || fail 'deployment status unavailable'
if has_micad; then
    bus GetUpdateState > /run/mica/service-update.json || fail 'native update service query'
    grep -F "$booted" /run/mica/service-update.json >/dev/null || fail 'service deployment identity mismatch'
    grep -F 'kernelId' /run/mica/service-update.json >/dev/null || fail 'service component identity absent'
    # A core set still pending (one this boot passed over, its trial unspent) is an update in progress to micad.
    if mica-deploy status | grep -F '"pending":null' >/dev/null; then
        grep -E 'succeeded|rolled-back' /run/mica/service-update.json >/dev/null || fail 'service did not observe confirmed success or fallback'
    fi
    echo FILE_AB_NATIVE_SERVICE_PASS
fi
mica-deploy firmware-readback | grep -F '"readbackVerified":true' || fail 'installed firmware readback'
cp /mnt/data/meta/firmware.json /run/mica/firmware-receipt.json
mica-deploy firmware-readback /run/mica/firmware-receipt.json --record | grep -F '"receiptRecorded":true' || fail 'firmware receipt recording'
cmp /run/mica/firmware-receipt.json /mnt/data/meta/firmware.json || fail 'firmware receipt changed'
echo FILE_AB_FIRMWARE_READBACK_PASS

if grep -q '^FEATURES=.*\bcontainers\b' /usr/lib/mica/product.conf; then
    . /usr/lib/mica/test-containers.sh
    container_checks
fi

for tag in /sys/bus/virtio/devices/*/mount_tag; do
    [ -r "$tag" ] || continue
    [ "$(cat "$tag")" = mica-update ] || continue
    mkdir -p /run/mica/import
    mount -t 9p -o trans=virtio,version=9p2000.L,ro mica-update /run/mica/import || fail 'offline test media mount'
    if [ -f /run/mica/import/actions.sh ]; then
        # One step of a sequence the host drives (core-sets.sh): what this boot installs and checks is on the media,
        # with `booted` and `fail` in scope. The step reports its own pass marker.
        . /run/mica/import/actions.sh
        umount /run/mica/import
        break
    fi
    expected=$(cat /run/mica/import/expected-id)
    if [ "$booted" != "$expected" ]; then
        storage_measurement before
        : > /run/mica/storage-sampling
        (
            count=0
            while [ -f /run/mica/storage-sampling ]; do
                count=$((count + 1))
                [ "$count" -le 6000 ] || exit 1
                storage_measurement sample || exit 1
                sleep 0.1
            done
        ) > /run/mica/storage-samples.log &
        sampler=$!
        # mica-deploy takes the caller's workspace budget (micad passes it from updates.json): 512 MiB here.
        mica-deploy --max-bytes 536870912 probe || fail 'DATA acquisition workspace probe'
        if [ -f /run/mica/import/update.micaupd ]; then
            mica-deploy --max-bytes 536870912 import /run/mica/import/update.micaupd || fail 'offline archive acquisition'
            install_deployment "/mica/updates/verified/$expected.json" /mica/updates/verified/objects
        else
            install_deployment /run/mica/import/deployment.json /run/mica/import/objects
        fi
        rm /run/mica/storage-sampling
        wait "$sampler" || fail 'storage sampler failed or exceeded its bound'
        cat /run/mica/storage-samples.log
        storage_measurement after
        echo "FILE_AB_INSTALL_PASS: $expected"
    else
        echo "FILE_AB_UPDATE_BOOT_PASS: $booted"
        mica-deploy gc || fail 'confirmed object collection'
    fi
    umount /run/mica/import
    break
done
! has_micad || [ -n "$(project_limits 101)" ] || fail 'project quota report'
# MODULE SIGNATURES, on a kernel that checks them (the module-signing kernel feature). A prod command line enforces
# them and locks the kernel down; on dev this turns the check on here (sig_enforce only ever turns on). A copy of a
# shipped module without its appended signature must be refused (EKEYREJECTED, "Key was rejected by service": the
# kernel's answer to an unsigned module under enforcement, kernel/module/signing.c), and the shipped, signed module
# must pass the check -- it may still fail its own init on this machine, which is not a key error.
if [ -e /sys/module/module/parameters/sig_enforce ]; then
    modrun() { if command -v "$1" >/dev/null 2>&1; then "$@"; else /usr/bin/busybox "$@"; fi; }
    if grep -qw mica.profile=prod /proc/cmdline; then
        grep -qw module.sig_enforce=1 /proc/cmdline && grep -qw lockdown=integrity /proc/cmdline || fail 'a prod command line without the module signature enforcement'
        grep -q '\[integrity\]' /sys/kernel/security/lockdown || fail "a prod kernel not locked down: $(cat /sys/kernel/security/lockdown)"
    fi
    echo 1 > /sys/module/module/parameters/sig_enforce
    [ "$(cat /sys/module/module/parameters/sig_enforce)" = Y ] || fail 'module signature enforcement did not turn on'
    release=$(uname -r)
    module=$(head -n 1 "/lib/modules/$release/modules.order")
    [ -n "$module" ] && [ -f "/lib/modules/$release/$module" ] || fail "no shipped module to load: '$module'"
    signed=/lib/modules/$release/$module
    [ "$(tail -c 28 "$signed")" = "~Module signature appended~" ] || fail "the shipped module $module carries no signature"
    set -- $(tail -c 32 "$signed" | head -c 4 | od -An -tu1)
    length=$(( $(stat -c %s "$signed") - 28 - 12 - ($1 * 16777216 + $2 * 65536 + $3 * 256 + $4) ))
    head -c "$length" "$signed" > /run/mica/unsigned.ko
    out=$(modrun insmod /run/mica/unsigned.ko 2>&1) && fail "an unsigned module loaded: $module"
    case "$out" in *'Key was rejected by service'*) ;; *) fail "an unsigned module was refused for another reason: $out" ;; esac
    out=$(modrun insmod "$signed" 2>&1) || case "$out" in *'Required key'* | *'Key was rejected'*) fail "the signed module $module was refused: $out" ;; esac
    grep -q "^$(basename "$module" .ko) " /proc/modules && modrun rmmod "$(basename "$module" .ko)"
    echo "FILE_AB_MODULE_SIGNATURE_PASS: $module (unsigned refused, signed accepted)"
fi
# THE OWNER KEYRING (CONFIG_MICA_OWNER_KEYRING), driven as core's runkit drives it: a module signed by an owner loads
# only once that owner's CA is enrolled in .mica_owner; after the seal no certificate can be added, a second seal
# says EEXIST, and a module of an owner never enrolled stays refused. Enforcement is on from the check above. The
# module is the KDK's hello (owner-modules.ts), so this also proves an out-of-tree build loads and runs.
if [ -d /usr/lib/mica/test-owner ]; then
    t=/usr/lib/mica/test-owner name=$(cat /usr/lib/mica/test-owner/module.name)
    "$t/owner-keyring" id >/dev/null || fail 'the kernel has no .mica_owner keyring'
    # Every step is named on the console and bounded, so a hang names its step instead of the suite's timeout.
    step() { echo "FILE_AB_OWNER_STEP: $*"; }
    ok() {
        tm=timeout; command -v timeout >/dev/null 2>&1 || tm='/usr/bin/busybox timeout'
        if command -v "$1" >/dev/null 2>&1; then $tm 30 "$@"; else $tm 30 /usr/bin/busybox "$@"; fi
    }
    refused() { step "refused $1"; out=$(ok insmod "$1" 2>&1) && fail "$2"; case "$out" in *'Key was rejected by service'*) ;; *) fail "$2 -- refused for another reason: $out" ;; esac; }
    # A kernel without CONFIG_MODULE_UNLOAD (mini-x64) keeps the module once loaded (busybox rmmod still exits 0, so
    # /proc/modules decides): the load after the seal is then reported as not checked rather than passed.
    unloads=1
    loads() {
        step "loads $1"; out=$(ok insmod "$1" 2>&1) || fail "$2: $out"
        grep -q "^$name " /proc/modules || fail "$2: not in /proc/modules"
        modrun rmmod "$name" 2>/dev/null || true
        ! grep -q "^$name " /proc/modules || unloads=0
    }
    refused "$t/owner.ko" 'an owner-signed module loaded before its CA was enrolled'
    step enrol; ok "$t/owner-keyring" add "$t/owner-ca.der" || fail 'enrolling the owner CA in .mica_owner'
    loads "$t/owner.ko" 'the owner-signed module was refused once its CA was enrolled'
    # The module is the KDK's reference module, built out of tree and packed by driver-ext: it runs on this kernel.
    modrun dmesg | grep -q 'mica hello: loaded' || fail 'the KDK-built module loaded without running its init'
    refused "$t/other.ko" 'a module of an owner never enrolled loaded'
    step seal; ok "$t/owner-keyring" seal || fail 'sealing .mica_owner'
    step 'enrol after the seal'; out=$(ok "$t/owner-keyring" add "$t/other-ca.der" 2>&1) && fail 'a certificate was enrolled after the seal'
    out=$(ok "$t/owner-keyring" seal 2>&1) && fail 'a second seal succeeded'
    case "$out" in *EEXIST*) ;; *) fail "a second seal failed for another reason: $out" ;; esac
    refused "$t/other.ko" 'a module of an owner refused enrolment after the seal loaded'
    if [ "$unloads" = 1 ]; then
        loads "$t/owner.ko" 'the enrolled owner-signed module was refused after the seal'
        echo 'FILE_AB_OWNER_KEYRING_PASS: enrolled owner loads, KDK module runs, unenrolled refused, sealed (EEXIST)'
    else
        echo 'FILE_AB_OWNER_KEYRING_PASS: enrolled owner loads, KDK module runs, unenrolled refused, sealed (EEXIST); the load after the seal is not checked, this kernel cannot unload modules'
    fi
fi
echo FILE_AB_RUNTIME_PASS
power_off
