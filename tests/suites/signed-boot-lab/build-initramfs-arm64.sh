#!/usr/bin/env bash
# The arm64 half of build-initramfs.sh: the same archive, assembled inside a
# linux/arm64 build because this host cannot execute an arm64 container.
#
#   bash tests/suites/signed-boot-lab/build-initramfs-arm64.sh [output-name]
#
# The builder is BUILDX_BUILDER when set, and `mica-arm64` otherwise -- the same
# selection rootfs/build.sh makes, and for the same
# reason: the docker driver reaches linux/arm64 only where the host has binfmt
# registered, while the docker-container builder bundles its own emulator.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
OUT="${1:-initramfs.cpio}"
[ -d "${LAB_WORK}/payload" ] || {
    echo "error: ${LAB_WORK}/payload does not exist. Run tests/suites/signed-boot-lab/prepare-payload.sh first" >&2
    exit 1
}
BUILDER="${BUILDX_BUILDER:-mica-arm64}"
docker buildx inspect "${BUILDER}" >/dev/null 2>&1 ||
    docker buildx create --name "${BUILDER}" --driver docker-container >/dev/null

SNAPSHOT="$(bash "${REPO_ROOT}/bin/bun.sh" src/cli.ts locks rows apt mica-system-base | cut -f2)"
mapfile -t TRIXIE_ARG < <(bash "${REPO_ROOT}/bin/bun.sh" src/cli.ts from MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim)
[ "${#TRIXIE_ARG[@]}" -eq 2 ] || { echo "error: the image resolver (bin/bun.sh src/cli.ts from) did not resolve upstream:debian:trixie-slim" >&2; exit 1; }

TMP="${LAB_WORK}/arm64-initramfs"
rm -rf "${TMP}"; mkdir -p "${TMP}/ctx"
docker buildx build --builder "${BUILDER}" \
    --build-context inits="${LAB_DIR}" \
    --build-context payload="${LAB_WORK}/payload" \
    "${TRIXIE_ARG[@]}" --build-arg "MICA_DEBIAN_SNAPSHOT=${SNAPSHOT}" \
    -f "${LAB_DIR}/Dockerfile.guest-arm64" --target out \
    -o "${TMP}" "${TMP}/ctx"
mv "${TMP}/initramfs.cpio" "${LAB_WORK}/${OUT}"
ls -la "${LAB_WORK}/${OUT}"
