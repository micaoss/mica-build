#!/bin/bash
# Interrupt the production reset applier and verify retry on full current images.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
root=$(realpath "${1:?full production root image required}")
kernel=$(realpath "${2:?BSP kernel directory required}")
cert=$(realpath "${3:?content certificate required}")
key=$(realpath "${4:?content key required}")
runkit=$(realpath "${5:?production mica-runkit required}")
board=${6:?board required}
# The board's facts, out of its fetched bundle: the suite boots UEFI boards
# of either architecture and dispatches on nothing else.
[ -f "_out/boards/$board/board.env" ] || { echo "error: $board is not a fetched board (make board-fetch BOARD=$board)" >&2; exit 1; }
[ "$(sed -n 's/^BOOT_BACKEND=//p' "_out/boards/$board/board.env")" = systemd-boot ] || { echo "error: $board boots a FIT; this suite boots UEFI boards" >&2; exit 1; }
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/$board/board.env")"
case "$arch" in amd64) compiler=gcc;; arm64) compiler=aarch64-linux-gnu-gcc;; esac
work=$(mktemp -d "$PWD/_out/reset-runtime.XXXXXX")
printf 'Evidence: %s\n' "$work"
# The Bun orchestrator mounts this project; keep explicit signing inputs inside it.
install -m 0644 "$cert" "$work/content.cert.pem"
install -m 0600 "$key" "$work/content.key.pem"
cert="$work/content.cert.pem"
key="$work/content.key.pem"
# The Rust builder supplies the pinned native and cross C linkers.
builder=$(bash bin/bun.sh src/cli.ts from --ref mica-build-env:rust)
timeout -k 15 180 docker run --rm --platform linux/amd64 --label ai-agent=true --network traefik \
    -v "$work:/w" -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" --entrypoint /bin/bash "$builder" \
    -c 'set -euo pipefail; command -v "$1"; "$1" -Wall -Wextra -Werror -shared -fPIC /harness/reset-fault.c -o /w/reset-fault.so -ldl' reset-compiler "$compiler"
for tier in configuration application-data full-factory; do
    out="$work/$tier"
    mkdir "$out"
    # mica-build-side: container-block -- extract with the pinned component tools.
    timeout -k 15 240 docker run --rm --label ai-agent=true --network traefik \
        -v "$out:/w" -v "$root:/root.img:ro" ai-agent/mica-boot-tools-amd64 \
        unsquashfs -no-progress -d /w/tree /root.img > "$out/extract.log" 2>&1
    # mica-build-side: host
    install -m 0755 tests/suites/lifecycle-uefi/reset-runtime.sh "$out/tree/usr/lib/mica/reset-runtime"
    install -m 0644 "$work/reset-fault.so" "$out/tree/usr/lib/mica/reset-fault.so"
    printf '%s\n' "$tier" > "$out/tree/usr/lib/mica/reset-test-tier"
    mkdir -p "$out/tree/etc/systemd/system/micad.service.d"
    cat > "$out/tree/etc/systemd/system/micad.service.d/90-reset-acceptance.conf" <<'UNIT'
[Service]
Environment=LD_PRELOAD=/usr/lib/mica/reset-fault.so
StandardOutput=journal+console
StandardError=journal+console
UNIT
    cat > "$out/tree/etc/systemd/system/reset-acceptance.service" <<'UNIT'
[Unit]
Description=Interrupted reset acceptance
After=multi-user.target mica-load-extensions.service mica-health.service
[Service]
Type=exec
ExecStart=/usr/lib/mica/reset-runtime
RuntimeMaxSec=240
[Install]
WantedBy=multi-user.target
UNIT
    ln -s /etc/systemd/system/reset-acceptance.service "$out/tree/etc/systemd/system/multi-user.target.wants/reset-acceptance.service"
    timeout -k 20 900 bash bin/bun.sh tests/suites/lifecycle-uefi/build.ts "$out/boot" "$board" "$kernel" "$cert" "$key" "$runkit" "$out/tree" > "$out/build.log" 2>&1
    truncate -s 4G "$out/boot/image/disk.img"
    for boot in 1 2 3; do
        timeout -k 15 600 docker run --rm --label ai-agent=true --network traefik \
            -v "$out/boot:/w" -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
            bash /harness/boot.sh image/disk.img writable 540 "$arch" > "$out/boot-$boot.log" 2>&1
        if [ "$boot" = 1 ]; then
            grep -F "FILE_AB_RESET_STAGED: $tier" "$out/boot-$boot.log"
        else
            grep -F "FILE_AB_RESET_RETRY_PASS: $tier" "$out/boot-$boot.log"
            if [ "$boot" = 2 ]; then
                [ "$(grep -c FILE_AB_RESET_INTERRUPTION "$out/boot-$boot.log")" = 1 ]
            else
                ! grep -F FILE_AB_RESET_INTERRUPTION "$out/boot-$boot.log"
            fi
        fi
        bash tests/suites/lifecycle-uefi/shutdown-check.sh "$out/boot-$boot.log"
    done
    echo "FILE_AB_INTERRUPTED_RESET_PASS: $board $tier"
done
