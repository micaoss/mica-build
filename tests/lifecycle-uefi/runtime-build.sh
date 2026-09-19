#!/bin/bash
# Compose a disposable acceptance root from the actual production root artifact.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
root_image=${1:?root image required}
kernel=${2:?BSP kernel directory required}
certificate=${3:?public content certificate required}
key=${4:?external content signing key required}
runkit=${5:?compiled mica-runkit required}
board=${6:?board required}
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
# mica-build-side: container-block -- the test units go into the tree IN THE
# CONTAINER THAT MADE IT. unsquashfs ran as root, so the extracted root is
# root-owned, and a host-side `install` into it works only when the host is root
# too. That is how this suite was written and it is why it failed the first time
# CI ran it on a hosted runner, as the runner user: "Permission denied" on
# tree/usr/lib/mica/test-file-runtime. Writing here keeps the root's ownership
# exactly as the product shipped it, which a chown of the tree would not.
docker run --rm --label ai-agent=true --network none -v "$scratch:/w" \
    -v "$PWD/tests/lifecycle-uefi:/in:ro" ai-agent/mica-boot-tools-amd64 sh -euc '
        install -m 0755 /in/runtime.sh /w/tree/usr/lib/mica/test-file-runtime
        install -m 0644 /in/runtime.service /w/tree/etc/systemd/system/test-file-runtime.service
        ln -s /etc/systemd/system/test-file-runtime.service /w/tree/etc/systemd/system/multi-user.target.wants/test-file-runtime.service
        install -m 0644 /in/var-state.service /w/tree/etc/systemd/system/test-var-state.service
        ln -s /etc/systemd/system/test-var-state.service /w/tree/etc/systemd/system/sysinit.target.wants/test-var-state.service'
# mica-build-side: host -- $scratch itself is the caller's, so these are the caller's to write.
install -m 0644 "$certificate" "$scratch/content.cert.pem"
install -m 0600 "$key" "$scratch/content.key.pem"
bash tests/lifecycle-uefi/bun.sh tests/lifecycle-uefi/build.ts "$evidence" "$board" "$kernel" "$scratch/content.cert.pem" "$scratch/content.key.pem" "$runkit" "$scratch/tree"
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
bash tests/lifecycle-uefi/bun.sh tools/qemu-seed-data.ts "$board" "$evidence/image/disk.img" \
    "$scratch/extension.service" /state/systemd-units/extension.service \
    --enable extension.service
# mica-build-side: container-block -- same reason: build.ts wrote this image
# from a container, so it is root-owned and the caller may not be root.
docker run --rm --label ai-agent=true --network none -v "$evidence:/w" ai-agent/mica-boot-tools-amd64 sh -euc '
    truncate -s 4G /w/image/disk.img
    cp --reflink=auto --sparse=always /w/image/disk.img /w/image/factory-disk.img'
printf '%s\n' "$evidence"
