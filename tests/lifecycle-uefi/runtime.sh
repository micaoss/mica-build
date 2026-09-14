#!/bin/sh
# Observe the full production services and writable namespace policy in QEMU.
set -eu
exec >/dev/console 2>&1
fail() {
    echo "FILE_AB_RUNTIME_FAIL: $*"
    journalctl --no-pager -b -u mica-data-layout -u systemd-repart -u systemd-growfs@mnt-data -u mica-load-extensions -u systemd-random-seed -u mica-health -u micad -u apid -n 160
    findmnt -rn -M /mnt/data
    systemctl poweroff --force
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
for unit in systemd-repart.service systemd-growfs@mnt-data.service mica-data-layout.service mica-seed-state.service systemd-random-seed.service systemd-tmpfiles-setup.service micad.service apid.service; do
    systemctl is-active --quiet "$unit" || fail "$unit is not active"
done
for path in /mnt/data /mica /mica/containers /srv /var /var/lib/mica; do
    findmnt -rn -M "$path" -o TARGET,SOURCE,FSTYPE,OPTIONS || fail "missing mount $path"
done
# Logical child mounts must never appear in the raw reset backing tree.
awk '$5 ~ /^\/mnt\/data\// { bad=1; print } END { exit bad }' /proc/self/mountinfo \
    || fail 'logical mounts propagated into reset backing storage'
mkdir /mica/containers/mount-proof
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
[ -f /var/lib/systemd/var-probe/ready ] || fail 'early StateDirectory service did not run'
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
set -- $(repquota -P -n -O csv /mnt/data | awk -F, '$1 == "#101" {print $6, $10}')
[ "$#" = 2 ] || fail 'variable project quota missing'
variable_kib=$1
variable_inodes=$2
[ "$variable_kib" -ge 32768 ] && [ "$variable_kib" -le 262144 ] || fail 'variable byte quota outside bounds'
[ "$variable_inodes" -ge 2048 ] && [ "$variable_inodes" -le 16384 ] || fail 'variable inode quota outside bounds'
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
[ "$(podman info --format '{{.Store.GraphRoot}}')" = /mica/containers/storage ] || fail 'Podman graph root differs'
[ "$(podman info --format '{{.Store.ImageCopyTmpDir}}')" = /mica/containers/tmp ] || fail 'Podman image downloads escaped the container namespace'
[ "$(podman info --format '{{.Store.RunRoot}}')" = /run/containers/storage ] || fail 'Podman runtime root differs'
podman volume create quota-proof >/dev/null || fail 'Podman named volume create'
volume_path=$(podman volume inspect quota-proof --format '{{.Mountpoint}}')
case "$volume_path" in /mica/containers/storage/volumes/*/_data) ;; *) fail 'named volume escaped container namespace';; esac
printf 'named volume write\n' >"$volume_path/proof" || fail 'named volume write'
podman volume rm quota-proof >/dev/null || fail 'Podman named volume cleanup'
for project in 100 102; do
    set -- $(repquota -P -n -O csv /mnt/data | awk -F, -v project="#$project" '$1 == project {print $5, $6, $9, $10}')
    [ "$*" = '0 0 0 0' ] || fail "project $project must have unlimited bytes and inodes"
done
if [ -f /mica/containers/persistence-proof ]; then
    [ "$(cat /mica/containers/persistence-proof)" = retained ] || fail 'container persistence differs'
    echo FILE_AB_CONTAINER_PERSISTENCE_PASS
else
    printf 'retained\n' >/mica/containers/persistence-proof
fi
echo FILE_AB_UNLIMITED_DATA_PASS

[ -e /run/mica/persistent-unit-ran ] || fail 'persistent extension was not loaded at startup'
seed_inode=$(stat -c %i /mnt/data/state/random-seed)
systemctl stop systemd-random-seed.service || fail 'random seed shutdown save'
[ "$(stat -c %i /mnt/data/state/random-seed)" = "$seed_inode" ] || fail 'random seed inode replaced'
[ "$(stat -c %s /mnt/data/state/random-seed)" -ge 32 ] || fail 'random seed not persisted'
systemctl start systemd-random-seed.service || fail 'random seed reload'
machine_id=$(cat /etc/machine-id)
[ "$machine_id" = "$(cat /mnt/data/state/machine-id)" ] || fail 'machine identity differs from DATA'
[ "${#machine_id}" -eq 32 ] || fail 'machine identity length'
[ "$(cat /var/lib/dbus/machine-id)" = "$machine_id" ] || fail 'D-Bus identity mismatch'
findmnt -rn -M /etc/machine-id -o OPTIONS | grep -qw ro || fail 'machine identity is writable'
echo "FILE_AB_MACHINE_ID: $machine_id"
booted=$(mica-deploy booted)
confirmed=0
for n in $(seq 1 100); do
    if mica-deploy status | grep -F "\"current\":\"$booted\"" >/dev/null; then confirmed=1; break; fi
    sleep 1
done
[ "$confirmed" = 1 ] || fail 'health did not confirm the deployment'
mica-deploy status || fail 'deployment status unavailable'
busctl --system --json=short call com.mica.micad /com/mica/micad com.mica.micad1 GetUpdateState > /run/mica/service-update.json || fail 'native update service query'
grep -F "$booted" /run/mica/service-update.json >/dev/null || fail 'service deployment identity mismatch'
grep -F 'kernelId' /run/mica/service-update.json >/dev/null || fail 'service component identity absent'
grep -E 'succeeded|rolled-back' /run/mica/service-update.json >/dev/null || fail 'service did not observe confirmed success or fallback'
echo FILE_AB_NATIVE_SERVICE_PASS
mica-deploy firmware-readback | grep -F '"readbackVerified":true' || fail 'installed firmware readback'
cp /mnt/data/meta/firmware.json /run/mica/firmware-receipt.json
mica-deploy firmware-readback /run/mica/firmware-receipt.json --record | grep -F '"receiptRecorded":true' || fail 'firmware receipt recording'
cmp /run/mica/firmware-receipt.json /mnt/data/meta/firmware.json || fail 'firmware receipt changed'
echo FILE_AB_FIRMWARE_READBACK_PASS

for tag in /sys/bus/virtio/devices/*/mount_tag; do
    [ -r "$tag" ] || continue
    [ "$(cat "$tag")" = mica-update ] || continue
    mkdir -p /run/mica/import
    mount -t 9p -o trans=virtio,version=9p2000.L,ro mica-update /run/mica/import || fail 'offline test media mount'
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
        mica-deploy probe || fail 'DATA acquisition workspace probe'
        if [ -f /run/mica/import/update.micaupd ]; then
            mica-deploy import /run/mica/import/update.micaupd || fail 'offline archive acquisition'
            install_deployment "/mica/updates/verified/$expected.json" /mica/updates/verified/objects
        elif [ -f /run/mica/import/source-url ]; then
            source=$(cat /run/mica/import/source-url)
            mica-deploy check --source "$source" --channel stable || fail 'signed online catalog check'
            mica-deploy fetch --source "$source" --channel stable || fail 'online component acquisition'
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
repquota -P -n -O csv /mnt/data || fail 'project quota report'
echo FILE_AB_RUNTIME_PASS
systemctl --no-block poweroff
