#!/bin/bash
# The user's own disks (mica-core docs/plan/user-storage.md, U3; mica-system-base docs/floor-and-options.md, "The
# user's own mounts"), over a copy of the runtime image a product already booted, with a second virtio disk
# attached (boot.sh, DISK2). Each boot runs the runtime suite with one step's actions.sh on the offline media
# (runtime.sh), `booted`, `fail`, `bus` and `INIT` in scope; systemd products write units with mica-unit, OpenRC
# products /usr/local/etc/fstab. In order:
#   map      the write map of the root, compared with write-map/<product>.txt (MICA_WRITE_MAP_RECORD=1 records it);
#            a refused mountpoint; then a mount under /srv, a swap partition and, with podman, the engine's root
#   mounted  all three on the user's disk, the engine running a container on it; the mount under /srv replaced by
#            one at /srv itself
#   srv      /srv is the user's disk and DATA's srv/ is kept as it was; an application-data reset staged
#   reset    the reset ran: the user's disk untouched, DATA's srv/ not cleared, the user's mount units gone; a
#            mount under /srv and the engine's root declared again, both nofail
#   removed  a boot without the disk: it comes up, micad answers, the engine is refused for its missing root
# The runtime image itself is left as it was.
#
#   bash tests/suites/lifecycle-uefi/user-storage.sh <runtime evidence> <board> <product>
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
evidence=${1:?runtime evidence directory required}
board=${2:?board required}
product=${3:?product required}
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
golden="$PWD/tests/suites/lifecycle-uefi/write-map/$product.txt"
[ "${MICA_WRITE_MAP_RECORD:-}" = 1 ] || [ -f "$golden" ] || { echo "error: no write map for $product ($golden); record one with MICA_WRITE_MAP_RECORD=1" >&2; exit 1; }
test ! -e "$evidence/offline"
out="$evidence/user-storage"
rm -rf "$out"
mkdir -p "$out"
# The steps change DATA; the runtime image goes back as it was when they end.
cp --reflink=auto --sparse=always "$evidence/image/disk.img" "$out/runtime-disk.img"
restore() { mv -f "$out/runtime-disk.img" "$evidence/image/disk.img"; rm -rf "$evidence/offline"; }
trap restore EXIT

# The user's disk: GPT, a 128 MiB ext4 for a mount under /srv, a 64 MiB swap, a 128 MiB ext4 for the engine's root
# and a 128 MiB ext4 for /srv itself, each with a fixed UUID; the two data file systems carry a file to read back.
# mica-build-side: container-block -- partition and format with the lab image's tools.
docker run --rm --label ai-agent=true --network traefik -v "$out:/w" --entrypoint /bin/bash ai-agent/mica-p2-lab -euo pipefail -c '
cd /w
rm -rf disk.parts && mkdir -p disk.parts/data disk.parts/srv
echo MICA_USER_DISK_DATA > disk.parts/data/hello.txt
echo MICA_USER_DISK_SRV > disk.parts/srv/hello.txt
mke2fs -q -t ext4 -F -U 6d1c0000-0000-4000-8000-000000000001 -L user-data -d disk.parts/data disk.parts/1.img 128M
dd if=/dev/zero of=disk.parts/2.img bs=1M count=64 status=none
chmod 0600 disk.parts/2.img
mkswap -U 6d1c0000-0000-4000-8000-000000000002 -L user-swap disk.parts/2.img >/dev/null
mke2fs -q -t ext4 -F -U 6d1c0000-0000-4000-8000-000000000003 -L user-engine disk.parts/3.img 128M
mke2fs -q -t ext4 -F -U 6d1c0000-0000-4000-8000-000000000004 -L user-srv -d disk.parts/srv disk.parts/4.img 128M
rm -f user-disk.img && truncate -s 452M user-disk.img
# Starts in sectors, at 1, 129, 193 and 321 MiB (sgdisk -q takes no size suffix there and says nothing).
sgdisk -o -n 1:2048:+128M -c 1:user-data -n 2:264192:+64M -t 2:8200 -c 2:user-swap \
    -n 3:395264:+128M -c 3:user-engine -n 4:657408:+128M -c 4:user-srv user-disk.img >/dev/null
[ "$(sgdisk -p user-disk.img | grep -c "^ *[1-4] ")" = 4 ] || { sgdisk -p user-disk.img; exit 1; }
for p in 1:1 2:129 3:193 4:321; do dd if="disk.parts/${p%%:*}.img" of=user-disk.img bs=1M seek="${p#*:}" conv=notrunc status=none; done
rm -rf disk.parts
' >"$out/disk.log" 2>&1 || { echo "error: the user disk was not made; see $out/disk.log" >&2; cat "$out/disk.log" >&2; exit 1; }
# mica-build-side: host

# step <name> <disk attached: yes|no> <actions>
step() {
    local name=$1 disk=$2 actions=$3
    rm -rf "$evidence/offline"
    mkdir -p "$evidence/offline"
    printf '%s\n' "$actions" >"$evidence/offline/actions.sh"
    local attach=()
    [ "$disk" = no ] || attach=(-e DISK2=user-storage/user-disk.img)
    docker run --rm --label ai-agent=true --network traefik -v "$evidence:/w" "${attach[@]}" \
        -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
        bash /harness/boot.sh image/disk.img writable 400 "$arch" >"$out/$name.log" 2>&1 || true
    rm -rf "$evidence/offline"
    grep -aF "FILE_AB_STEP_PASS: $name" "$out/$name.log" >/dev/null ||
        { echo "error: step $name failed; see $out/$name.log" >&2; grep -a -E 'FILE_AB_[A-Z_]*FAIL' "$out/$name.log" >&2 || true; exit 1; }
    echo "step $name: $(grep -a -E 'FILE_AB_STEP_PASS|FILE_AB_USER_STORAGE' "$out/$name.log" | tr -d '\r' | tr '\n' ' ')"
}

# Shared by every step's actions: the disk's file systems, and how this init declares a user's mount.
common=$(cat <<'ACTIONS'
U_DATA=6d1c0000-0000-4000-8000-000000000001
U_SWAP=6d1c0000-0000-4000-8000-000000000002
U_ENGINE=6d1c0000-0000-4000-8000-000000000003
U_SRV=6d1c0000-0000-4000-8000-000000000004
engine=$(sed -n 's/^CONTAINER_ENGINE=//p' /usr/lib/mica/product.conf)
# The engine's root a user may mount at; empty without podman (docker's root is not exercised here).
root=
[ "$engine" != podman ] || root=/mica/containers/storage
note() { echo "FILE_AB_USER_STORAGE: $*"; }
source_of() { findmnt -rn -M "$1" -o SOURCE 2>/dev/null; }
# declare <name> <where> <uuid> <options>: a mount (systemd: a .mount unit; OpenRC: an fstab line).
declare_mount() {
    if [ "$INIT" = systemd ]; then
        unit=/run/mica/$(systemd-escape --path --suffix=mount "$2")
        printf '[Unit]\nDescription=%s\n[Mount]\nWhat=/dev/disk/by-uuid/%s\nWhere=%s\nType=ext4\nOptions=%s\n[Install]\nWantedBy=local-fs.target\n' \
            "$1" "$3" "$2" "$4" >"$unit"
        mica-unit install "$unit" || fail "mica-unit install ${unit##*/}"
        mica-unit enable "${unit##*/}" || fail "mica-unit enable ${unit##*/}"
    else
        printf 'UUID=%s %s ext4 %s 0 2\n' "$3" "$2" "$4" >>/usr/local/etc/fstab
    fi
}
declare_swap() {
    if [ "$INIT" = systemd ]; then
        unit=/run/mica/$(systemd-escape --path --suffix=swap "/dev/disk/by-uuid/$U_SWAP")
        printf '[Unit]\nDescription=swap on the user disk\n[Swap]\nWhat=/dev/disk/by-uuid/%s\n[Install]\nWantedBy=swap.target\n' "$U_SWAP" >"$unit"
        mica-unit install "$unit" || fail "mica-unit install ${unit##*/}"
        mica-unit enable "${unit##*/}" || fail "mica-unit enable ${unit##*/}"
    else
        printf 'UUID=%s none swap sw 0 0\n' "$U_SWAP" >>/usr/local/etc/fstab
    fi
}
# forget_mounts: none of the user's mounts declared any more.
forget_mounts() {
    if [ "$INIT" = systemd ]; then
        for unit in /usr/local/lib/systemd/system/*.mount /usr/local/lib/systemd/system/*.swap; do
            [ -e "$unit" ] || continue
            mica-unit disable "${unit##*/}" >/dev/null 2>&1 || true
            rm -f "$unit"
        done
    else
        rm -f /usr/local/etc/fstab
    fi
}
check_fstab() { [ "$INIT" = systemd ] || mica-unit fstab check || fail "mica-unit fstab check: $(cat /usr/local/etc/fstab)"; }
ACTIONS
)

# 1. The write map before any user mount, a refused mountpoint, then the first mounts declared.
step map yes "$common
$(cat <<'ACTIONS'
[ -b /dev/vdb1 ] && [ -b /dev/vdb4 ] || fail 'the user disk is not attached as vdb'
# The write map: every mount but this test's own media, the engine's runtime ones and binfmt_misc, which systemd
# mounts when something first asks; devtmpfs and systemd's /run/initramfs without the size and inode count derived
# from the memory the kernel leaves free.
findmnt -rn -o TARGET,FSTYPE,FSROOT,OPTIONS |
    awk '$1 != "/run/mica/import" && $1 !~ "^/run/netns/" && $1 !~ "^/mica/containers/storage/" && $1 !~ "^/run/containers/" && $1 !~ "^/mica/containers/mount-proof" && $1 != "/proc/sys/fs/binfmt_misc"' |
    sed -E '/^([^ ]+ devtmpfs|\/run\/initramfs tmpfs) /s/,(size|nr_inodes)=[0-9]+k?//g' |
    sort | while read -r line; do echo "FILE_AB_WRITEMAP: $line"; done
# A refused mountpoint: not declared, with the reason.
if [ "$INIT" = systemd ]; then
    printf '[Mount]\nWhat=/dev/disk/by-uuid/%s\nWhere=/var/lib/mica/user\nType=ext4\n[Install]\nWantedBy=local-fs.target\n' "$U_DATA" >/run/mica/var-lib-mica-user.mount
    refusal=$(mica-unit install /run/mica/var-lib-mica-user.mount 2>&1) && fail 'mica-unit installed a mount at /var/lib/mica/user'
    [ ! -e /usr/local/lib/systemd/system/var-lib-mica-user.mount ] || fail 'the refused unit was installed'
    # One put on DATA by hand, past mica-unit: the generator masks it and says why.
    printf '[Mount]\nWhat=/dev/disk/by-uuid/%s\nWhere=/mnt/user\nType=ext4\n[Install]\nWantedBy=local-fs.target\n' "$U_DATA" >/usr/local/lib/systemd/system/mnt-user.mount
    mkdir -p /usr/local/lib/systemd/system/local-fs.target.wants
    ln -sfn ../mnt-user.mount /usr/local/lib/systemd/system/local-fs.target.wants/mnt-user.mount
else
    printf 'UUID=%s /var/lib/mica/user ext4 defaults 0 2\n' "$U_DATA" >/run/mica/refused.fstab
    refusal=$(mica-unit fstab check /run/mica/refused.fstab 2>&1) && fail 'mica-unit fstab check passed /var/lib/mica/user'
fi
case "$refusal" in *'refused mountpoint /var/lib/mica/user'*) ;; *) fail "the refusal does not name the mountpoint: $refusal" ;; esac
note "refused: $refusal"
# What DATA's srv/ holds, to find it again as it was.
echo kept > /srv/kept-on-data
declare_mount 'a user disk under /srv' /srv/data "$U_DATA" nosuid,nodev,noatime
declare_swap
[ -z "$root" ] || declare_mount "the engine's root on a user disk" "$root" "$U_ENGINE" nosuid,nodev,noatime
check_fstab
# From here this suite moves the engine's root and resets the application data: the runtime suite leaves the
# engine and the app accounts to it (runtime.sh).
touch /mica/.user-storage
sync
echo "FILE_AB_STEP_PASS: map"
ACTIONS
)"
grep -a '^FILE_AB_WRITEMAP: ' "$out/map.log" | tr -d '\r' | cut -d' ' -f2- >"$out/write-map.txt"
if [ "${MICA_WRITE_MAP_RECORD:-}" = 1 ]; then
    mkdir -p "$(dirname "$golden")"
    cp "$out/write-map.txt" "$golden"
    echo "write map recorded: $golden"
else
    diff -u "$golden" "$out/write-map.txt" ||
        { echo "error: the write map of $product is not write-map/$product.txt (MICA_WRITE_MAP_RECORD=1 records it)" >&2; exit 1; }
fi

# 2. The mounts on the user's disk, the engine on its root there; then /srv itself on the disk.
step mounted yes "$common
$(cat <<'ACTIONS'
[ "$(source_of /srv/data)" = /dev/vdb1 ] || fail "/srv/data is not the user disk: $(findmnt -rn -M /srv/data)"
case ",$(findmnt -rn -M /srv/data -o OPTIONS)," in *,nosuid,*nodev,*) ;; *) fail "/srv/data options: $(findmnt -rn -M /srv/data -o OPTIONS)" ;; esac
[ "$(cat /srv/data/hello.txt)" = MICA_USER_DISK_DATA ] || fail 'the user disk under /srv does not read back'
echo written > /srv/data/written || fail 'the user disk under /srv is not writable'
[ ! -e /mnt/data/srv/data/hello.txt ] || fail 'the mount under /srv reached DATA'
grep -q '^/dev/vdb2 ' /proc/swaps || fail "the swap partition is not on: $(cat /proc/swaps)"
note "swap: $(grep '^/dev/vdb2 ' /proc/swaps | tr -s ' ')"
if [ "$INIT" = systemd ]; then
    [ "$(systemctl show -p LoadState --value mnt-user.mount)" = masked ] || fail "the refused mnt-user.mount is $(systemctl show -p LoadState --value mnt-user.mount)"
    ! findmnt -rn -M /mnt/user >/dev/null || fail 'the refused /mnt/user is mounted'
    dmesg | grep -F 'mica-user-mounts-generator: refused mountpoint /mnt/user' >/dev/null || fail 'the generator did not say why it masked mnt-user.mount'
    note 'mnt-user.mount masked, refused mountpoint /mnt/user in the kernel log'
    rm -f /usr/local/lib/systemd/system/mnt-user.mount /usr/local/lib/systemd/system/local-fs.target.wants/mnt-user.mount
fi
if [ -n "$root" ]; then
    [ "$(source_of "$root")" = /dev/vdb3 ] || fail "the engine's root is not the user disk: $(findmnt -rn -M "$root")"
    rm -rf /run/mica/probe-image && mkdir -p /run/mica/probe-image/bin
    cp /usr/bin/busybox /run/mica/probe-image/bin/busybox && ln -s busybox /run/mica/probe-image/bin/sh
    tar -c -C /run/mica/probe-image . | podman import - localhost/mica-user-disk:1 >/dev/null || fail 'podman import onto the user disk'
    said=$(podman run --rm --network none localhost/mica-user-disk:1 /bin/sh -c 'echo MICA_ON_USER_DISK') || fail 'podman run on the user disk'
    [ "$said" = MICA_ON_USER_DISK ] || fail "the container said $said"
    [ -n "$(ls -A "$root/overlay" 2>/dev/null)" ] || fail "the engine wrote no layers under $root"
    [ ! -e "/mnt/data/containers/storage/overlay-images/images.json" ] || ! grep -F mica-user-disk /mnt/data/containers/storage/overlay-images/images.json >/dev/null ||
        fail 'the image went to DATA, not the user disk'
    note "engine root $root on /dev/vdb3, a container ran from it"
fi
# /srv itself on the disk instead of the mount under it.
forget_mounts
declare_mount '/srv on a user disk' /srv "$U_SRV" nosuid,nodev,noatime
declare_swap
[ -z "$root" ] || declare_mount "the engine's root on a user disk" "$root" "$U_ENGINE" nosuid,nodev,noatime
check_fstab
sync
echo "FILE_AB_STEP_PASS: mounted"
ACTIONS
)"

# 3. /srv is the user's disk, DATA's srv/ kept; an application-data reset staged with the user's mounts up.
step srv yes "$common
$(cat <<'ACTIONS'
[ "$(source_of /srv)" = /dev/vdb4 ] || fail "/srv is not the user disk: $(findmnt -rn -M /srv)"
[ "$(cat /srv/hello.txt)" = MICA_USER_DISK_SRV ] || fail 'the user disk at /srv does not read back'
[ ! -e /srv/kept-on-data ] || fail '/srv still shows DATA srv/'
[ "$(cat /mnt/data/srv/kept-on-data)" = kept ] || fail "DATA srv/ was not kept as it was"
echo survives > /srv/reset-survives
mkdir -p /mica/volumes && echo application > /mica/volumes/reset-content
note "/srv on /dev/vdb4, DATA srv/ kept"
# The reset boots with the engine's root on the disk too: no reset tier crosses into a mount (mica-core 0.0.7).
if [ -n "$root" ]; then
    [ "$(source_of "$root")" = /dev/vdb3 ] || fail "$root is not the user disk: $(findmnt -rn -M "$root")"
    echo survives > "$root/reset-survives"
fi
echo "FILE_AB_STEP_PASS: srv"
sync
bus SetSettings ss reset '{"tier":"application-data","requested":1}' || fail 'stage the application-data reset'
sync
ACTIONS
)"

# 4. The reset ran: nothing of the user's disk or of DATA's srv/ touched, their mount declarations gone.
step reset yes "$common
$(cat <<'ACTIONS'
if bus GetSettings s reset >/run/mica/reset-intent 2>&1; then fail "the reset is still staged: $(cat /run/mica/reset-intent)"; fi
grep -F 'settings path not found: `reset`' /run/mica/reset-intent >/dev/null || fail "reset status: $(cat /run/mica/reset-intent)"
[ ! -e /mica/volumes/reset-content ] || fail 'the application data was not cleared'
! grep -qs '^boottest:' /mnt/data/state/accounts/passwd /mnt/data/state/accounts/group ||
    fail 'the application-data reset kept the service account boottest on STATE'
# micad binds the accounts again after the reset (mica-accounts build); under systemd that bind stays in micad's own
# mount namespace, so this boot may still resolve the account until the next one.
note "boottest after the reset, this boot: $(id -u boottest 2>&1)"
[ -e /mica/.user-storage ] || fail 'the reset removed /mica/.user-storage'
[ "$(cat /mnt/data/srv/kept-on-data)" = kept ] || fail 'the reset cleared DATA srv/'
if [ "$INIT" = systemd ]; then
    [ -z "$(ls /usr/local/lib/systemd/system/*.mount /usr/local/lib/systemd/system/*.swap 2>/dev/null)" ] || fail 'the reset kept the user mount units'
else
    [ ! -e /usr/local/etc/fstab ] || fail 'the reset kept the user fstab'
fi
# The disk as the user left it: this boot still mounted it at /srv (the reset cleared the declarations after
# that), or reads it here.
disk_file() {
    at=$(findmnt -rn -S "$1" -o TARGET 2>/dev/null | sed -n '1p')
    if [ -n "$at" ]; then cat "$at/$2"; return; fi
    mkdir -p /run/mica/disk-check
    mount -o ro "$1" /run/mica/disk-check || fail "mount $1 to check it"
    cat "/run/mica/disk-check/$2"
    umount /run/mica/disk-check
}
[ "$(disk_file /dev/vdb4 reset-survives)" = survives ] && [ "$(disk_file /dev/vdb4 hello.txt)" = MICA_USER_DISK_SRV ] || fail 'the reset touched the user disk at /srv'
[ "$(disk_file /dev/vdb1 written)" = written ] || fail 'the reset touched the user disk under /srv'
if [ -n "$root" ]; then
    [ "$(disk_file /dev/vdb3 reset-survives)" = survives ] || fail "the reset touched the engine's root on the user disk"
    note "RESET_ENGINE_ROOT_PASS: $root on the user disk through the application-data reset, untouched"
fi
note "/srv in the reset boot: $(findmnt -rn -M /srv -o SOURCE)"
note 'reset: user disk untouched, DATA srv/ kept, the user mount declarations cleared'
# For the boot without the disk: a mount under /srv and the engine's root, both nofail.
declare_mount 'a user disk under /srv' /srv/data "$U_DATA" nosuid,nodev,noatime,nofail,x-systemd.device-timeout=10s
[ -z "$root" ] || declare_mount "the engine's root on a user disk" "$root" "$U_ENGINE" nosuid,nodev,noatime,nofail,x-systemd.device-timeout=10s
check_fstab
sync
echo "FILE_AB_STEP_PASS: reset"
ACTIONS
)"

# 5. The disk is gone: the device comes up and answers, the engine is refused for its root.
step removed no "$common
$(cat <<'ACTIONS'
[ ! -b /dev/vdb ] || fail 'the user disk is still attached'
bus GetUpdateState >/dev/null || fail 'micad does not answer without the user disk'
! findmnt -rn -M /srv/data >/dev/null || fail '/srv/data is mounted without its disk'
[ "$(source_of /srv)" != '' ] || fail '/srv lost its default bind'
if [ -n "$root" ]; then
    ! findmnt -rn -M "$root" >/dev/null || fail "$root is mounted without its disk"
    if [ "$INIT" = systemd ]; then
        state=$(systemctl show -p ActiveState --value mica-containerd.service)
        [ "$state" != active ] || fail 'the engine started without its root'
        note "mica-containerd $state ($(systemctl show -p Result --value mica-containerd.service))"
    else
        if reason=$(/usr/lib/mica/mica-require-mount "$root" 2>&1); then fail 'mica-require-mount passed a missing engine root'; fi
        case "$reason" in *"mica-require-mount: $root is not mounted;"*) ;; *) fail "mica-require-mount said: $reason" ;; esac
        ! rc-service mica-containerd status >/dev/null 2>&1 || fail 'the engine started without its root'
        note "engine refused: $reason"
    fi
    note "micad containers: $(bus GetContainers 2>&1 | cut -c1-300)"
fi
echo "FILE_AB_STEP_PASS: removed"
ACTIONS
)"
engine_case='no engine root (no podman)'
! grep -aF 'FILE_AB_USER_STORAGE: engine root' "$out/mounted.log" >/dev/null || engine_case='the engine root'
echo "USER_STORAGE_PASS: $product: the write map, a refused mountpoint, a mount under /srv, swap, /srv itself, $engine_case, an application-data reset, the disk removed"
