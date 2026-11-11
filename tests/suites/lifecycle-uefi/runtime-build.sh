#!/bin/bash
# Compose a disposable acceptance root from the actual production root artifact.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
root_image=${1:?root image required}
kernel=${2:?BSP kernel directory required}
certificate=${3:?public content certificate required}
key=${4:?external content signing key required}
runkit=${5:?compiled mica-runkit required}
board=${6:?board required}
cores=$(realpath "${7:?the signed core components of the seed core set (_out/products/<name>/core-set/cores) required}")
# The board's facts, out of its fetched bundle: the suite boots UEFI boards
# of either architecture and dispatches on nothing else.
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
scratch=$(mktemp -d "$PWD/_out/file-runtime.XXXXXX")
evidence="$scratch/boot"
mkdir "$scratch/tree"
# mica-build-side: container-block -- extract the production root using its pinned tools.
docker run --rm --label ai-agent=true --network traefik -v "$scratch:/w" \
    -v "$root_image:/root.img:ro" ai-agent/mica-boot-tools-amd64 \
    unsquashfs -f -d /w/tree /root.img >/dev/null
# DIAGNOSTIC: the owners of the extracted tree and of the product root it came from.
echo "diag: host uid $(id -u); tree top:" >&2; ls -lan "$scratch/tree" | sed -n 1,12p >&2
docker run --rm --label ai-agent=true --network none -v "$root_image:/root.img:ro" ai-agent/mica-boot-tools-amd64 \
    unsquashfs -lln /root.img | sed -n 1,12p >&2
# mica-build-side: host
# mica-build-side: container-block -- the test units go into the tree IN THE
# CONTAINER THAT MADE IT. unsquashfs ran as root, so the extracted root is
# root-owned, and a host-side `install` into it works only when the host is root
# too. That is how this suite was written and it is why it failed the first time
# CI ran it on a hosted runner, as the runner user: "Permission denied" on
# tree/usr/lib/mica/test-file-runtime. Writing here keeps the root's ownership
# exactly as the product shipped it, which a chown of the tree would not.
docker run --rm --label ai-agent=true --network none -v "$scratch:/w" \
    -v "$PWD/tests/suites/lifecycle-uefi:/in:ro" ai-agent/mica-boot-tools-amd64 sh -euc '
        install -m 0755 /in/runtime.sh /w/tree/usr/lib/mica/test-file-runtime
        install -m 0644 /in/guest-init.sh /w/tree/usr/lib/mica/test-init.sh
        install -m 0644 /in/containers.sh /w/tree/usr/lib/mica/test-containers.sh
        if grep -qx INIT=openrc /w/tree/usr/lib/mica/product.conf; then
            install -m 0755 /in/runtime.openrc /w/tree/etc/init.d/test-file-runtime
            ln -s /etc/init.d/test-file-runtime /w/tree/etc/runlevels/default/test-file-runtime
        else
            install -m 0644 /in/runtime.service /w/tree/etc/systemd/system/test-file-runtime.service
            ln -s /etc/systemd/system/test-file-runtime.service /w/tree/etc/systemd/system/multi-user.target.wants/test-file-runtime.service
            install -m 0644 /in/var-state.service /w/tree/etc/systemd/system/test-var-state.service
            ln -s /etc/systemd/system/test-var-state.service /w/tree/etc/systemd/system/sysinit.target.wants/test-var-state.service
            # The output of micad on the console too, and on each stop its status and the journal of this boot
            # for it: a micad that fails to start is otherwise silent in runtime.log, because the health gate
            # reboots the guest before runtime.sh reaches its journal dump.
            install -d -m 0755 /w/tree/etc/systemd/system/micad.service.d
            printf "%s\\n" "[Service]" "StandardOutput=journal+console" "StandardError=journal+console" \
                "ExecStopPost=-/bin/sh -c \"systemctl status micad --no-pager -l; journalctl -u micad -b --no-pager -n 80\"" \
                "ExecStopPost=-/bin/sh -c \"set -x; date -u; cat /usr/lib/mica/source-date-epoch 2>/dev/null; ls -la /var /run/dbus /mnt/data/var; ls -ld /var/run /mnt/data/var/run; readlink /var/run; findmnt /var\"" \
                "ExecStopPost=-/bin/sh -c \"set -x; systemd-tmpfiles --cat-config 2>&1 | grep -n -E -e var/run -e ^L -e ^# -e /run/dbus; ls -la /etc/tmpfiles.d /usr/lib/tmpfiles.d | sed -n 1,80p\"" \
                "ExecStopPost=-/bin/sh -c \"journalctl -b -u systemd-tmpfiles-setup -u systemd-tmpfiles-setup-dev --no-pager; journalctl -b -p warning --no-pager -n 120\"" \
                "ExecStopPost=-/bin/sh -c \"set -x; ls -lan /; find / -xdev -uid 1001 -ls; find / -xdev -gid 1001 -ls\"" \
                >/w/tree/etc/systemd/system/micad.service.d/test-console.conf
        fi'
# mica-build-side: host
# A TEST OVERLAY (MICA_TEST_ROOT_OVERLAY, a directory): files laid over the acceptance root, to prove a change a
# dependency has not released yet -- a Base package's payload, say -- against this tree. Never set by CI; the run
# names every file it lays.
if [ -n "${MICA_TEST_ROOT_OVERLAY:-}" ]; then
    overlay=$(realpath "$MICA_TEST_ROOT_OVERLAY")
    echo "warning: the acceptance root carries the test overlay $overlay: $(cd "$overlay" && find . -type f | sort | tr '\n' ' ')" >&2
    # mica-build-side: container-block -- into the root-owned tree, as above.
    docker run --rm --label ai-agent=true --network none -v "$scratch:/w" -v "$overlay:/overlay:ro" ai-agent/mica-boot-tools-amd64 \
        sh -euc 'cp -a /overlay/. /w/tree/'
    # mica-build-side: host
fi
# THE OWNER KEYRING (CONFIG_MICA_OWNER_KEYRING): the KDK's reference module packed by two owners, their CAs and
# the helper that enrols and seals as core's runkit does (owner-modules.ts); runtime.sh checks which modules load.
if grep -qx CONFIG_MICA_OWNER_KEYRING=y "$kernel/config"; then
    bash bin/bun.sh tests/suites/lifecycle-uefi/owner-modules.ts "$kernel" "$arch" "$scratch/owner"
    # mica-build-side: container-block -- into the root-owned tree, as above.
    docker run --rm --label ai-agent=true --network none -v "$scratch:/w" ai-agent/mica-boot-tools-amd64 sh -euc '
        install -d -m 0755 /w/tree/usr/lib/mica/test-owner
        install -m 0755 /w/owner/owner-keyring /w/tree/usr/lib/mica/test-owner/owner-keyring
        for f in owner.ko other.ko owner-ca.der other-ca.der module.name; do install -m 0644 "/w/owner/$f" /w/tree/usr/lib/mica/test-owner/; done'
fi
# mica-build-side: host
# $scratch itself is the caller's, so these are the caller's to write.
install -m 0644 "$certificate" "$scratch/content.cert.pem"
install -m 0600 "$key" "$scratch/content.key.pem"
bash bin/bun.sh tests/suites/lifecycle-uefi/build.ts "$evidence" "$board" "$kernel" "$scratch/content.cert.pem" "$scratch/content.key.pem" "$runkit" "$scratch/tree" "$cores"
echo "diag: tree top after build.ts:" >&2; ls -lan "$scratch/tree" | sed -n 1,12p >&2
docker run --rm --label ai-agent=true --network none -v "$evidence/root:/r:ro" ai-agent/mica-boot-tools-amd64 \
    unsquashfs -lln /r/rootfs.img | sed -n 1,12p >&2
cat >"$scratch/extension.service" <<'UNIT'
[Unit]
Description=Persistent extension acceptance
Before=test-file-runtime.service
[Service]
Type=oneshot
ExecStart=/usr/bin/touch /run/mica/persistent-unit-ran
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
UNIT
# An app account as micad keeps one on STATE (DATA/state/accounts): runtime.sh asserts the boot bound it.
printf 'boottest:x:30000:30000::/nonexistent:/usr/sbin/nologin\n' >"$scratch/accounts.passwd"
printf 'boottest:x:30000:\n' >"$scratch/accounts.group"
bash bin/bun.sh src/image/qemu-seed-data.ts "$board" "$evidence/image/disk.img" \
    "$scratch/extension.service" /state/systemd-units/extension.service \
    "$scratch/accounts.passwd" /state/accounts/passwd "$scratch/accounts.group" /state/accounts/group \
    --enable extension.service
# mica-build-side: container-block -- the rest of the disk work, and then the
# evidence directory becomes the CALLER'S. build.ts wrote this image from a
# container, so it and its directory are root-owned, and every stage after this
# one writes into them from the host: run.sh redirects the guest's console into
# runtime.log here. Ownership of logs and disk images is not part of what the
# product ships -- unlike tree/, which must keep the root's own ownership -- so
# handing them to the caller is safe, and it is what makes this suite runnable
# by anyone who is not root.
docker run --rm --label ai-agent=true --network none -v "$evidence:/w" ai-agent/mica-boot-tools-amd64 sh -euc '
    truncate -s 4G /w/image/disk.img
    cp --reflink=auto --sparse=always /w/image/disk.img /w/image/factory-disk.img
    chown -R "$1:$2" /w' _ "$(id -u)" "$(id -g)"
# mica-build-side: host
# Asserted rather than assumed: this is the fourth place where a container-made
# file met a host-side write, and the first three were each found by a CI run
# on a non-root host rather than here.
[ -w "$evidence" ] ||
    { echo "error: $evidence is not writable by $(id -un); every stage after this one writes its log there" >&2; exit 1; }
printf '%s\n' "$evidence"
