#!/usr/bin/env bash
# Build the boot packager image for one EFI architecture.
#
#   bash boot/build-tools.sh [--target {x64|aa64}]      -> ai-agent/mica-boot-tools-<amd64|arm64>
#
# Its Debian packages come from the one archive the Base release names (the apt
# row of locks/mica-system-base.lock), and its unsigned systemd-boot loader from
# the Base pool's mica-systemd-boot of the target architecture. The producer
# tools run on amd64; the target selects the produced EFI ABI.
# MICA_BOOT_LOADER_DEB names another copy of the loader.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/.." && pwd)"
# The image and the tools it copies in: the boot stage of the tree (shell that runs inside the image).
STAGE="${REPO}/stages/boot"
TARGET=${MICA_BOOT_TARGET-x64}
if [ "$#" -ne 0 ]; then
    [ "$#" -eq 2 ] && [ "$1" = --target ] || {
        echo 'usage: build-tools.sh [--target {x64|aa64}]' >&2; exit 64;
    }
    [ -z "${MICA_BOOT_TARGET+x}" ] || [ "$TARGET" = "$2" ] || {
        echo 'error: conflicting boot-tools targets' >&2; exit 64;
    }
    TARGET=$2
fi
case "$TARGET" in
    x64) IMAGE_TARGET=amd64 ;;
    aa64) IMAGE_TARGET=arm64 ;;
    *) echo 'error: boot-tools target must be x64 or aa64' >&2; exit 64 ;;
esac
command -v docker >/dev/null
# Both inputs are read, never fetched, here: locks/mica-system-base.lock is
# committed, and `bash tools/pool.sh fetch --arch <arch> --packages mica-systemd-boot`
# puts the loader in place (tools/product-build.sh runs it).
SNAPSHOT="$(bash "$REPO/bin/bun.sh" src/cli.ts locks rows apt mica-system-base | cut -f2)" && [ -n "$SNAPSHOT" ] ||
    { echo "error: the boot tools install from the one Debian archive the apt row of locks/mica-system-base.lock names (see above)" >&2; exit 1; }
SNAPSHOT="${SNAPSHOT/https:\/\//http:\/\/}"
LOADER_DEB="${MICA_BOOT_LOADER_DEB:-}"
if [ -z "$LOADER_DEB" ]; then
    found=("$REPO/_out/debs/$IMAGE_TARGET/pool/"mica-systemd-boot_*_"$IMAGE_TARGET".deb)
    [ "${#found[@]}" -eq 1 ] && [ -f "${found[0]}" ] || { echo "error: expected exactly one mica-systemd-boot archive in _out/debs/$IMAGE_TARGET/pool (bash tools/pool.sh fetch --arch $IMAGE_TARGET --packages mica-systemd-boot)" >&2; exit 1; }
    LOADER_DEB="${found[0]}"
fi
LOADER_CONTEXT="$REPO/_out/boot-tools/loader-$IMAGE_TARGET"
rm -rf "$LOADER_CONTEXT"; mkdir -p "$LOADER_CONTEXT"
cp "$LOADER_DEB" "$LOADER_CONTEXT/mica-systemd-boot.deb"
mapfile -t BASE < <(bash "${REPO}/bin/bun.sh" src/cli.ts from MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim)
test "${#BASE[@]}" = 2
# The image's pinned inputs, as the label mica.boot.inputs: what a kernel component's buildId names of its
# packager, rather than the local image id, which moves with every rebuild of the same inputs.
INPUTS="$( {
    printf 'base %s\nsnapshot %s\ntarget %s\nloader %s\n' "${BASE[1]#*=}" "$SNAPSHOT" "$TARGET" "$(sha256sum "$LOADER_DEB" | cut -d' ' -f1)"
    (cd "$STAGE" && sha256sum Dockerfile initramfs.sh kernel.sh compression.sh elf-closure.sh)
} | sha256sum | cut -d' ' -f1)"
docker build --platform linux/amd64 --label ai-agent=true --label "mica.boot.inputs=$INPUTS" -t "ai-agent/mica-boot-tools-$IMAGE_TARGET" \
    "${BASE[@]}" --build-arg "MICA_DEBIAN_SNAPSHOT=$SNAPSHOT" --build-arg "MICA_BOOT_TARGET=$TARGET" \
    --build-context "loader=$LOADER_CONTEXT" "$STAGE"
