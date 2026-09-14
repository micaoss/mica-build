#!/usr/bin/env bash
# The arm64 half of build-initramfs.sh: the same archive, assembled inside a
# linux/arm64 build because this host cannot execute an arm64 container.
#
#   bash tests/signed-boot-lab/build-initramfs-arm64.sh [output-name]
#
# The builder is BUILDX_BUILDER when set, and `mica-arm64` otherwise -- the same
# selection rootfs/build.sh makes, and for the same
# reason: the docker driver reaches linux/arm64 only where the host has binfmt
# registered, while the docker-container builder bundles its own emulator.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"
OUT="${1:-initramfs.cpio}"
[ -d "${LAB_WORK}/payload" ] || {
    echo "error: ${LAB_WORK}/payload does not exist. Run tests/signed-boot-lab/prepare-payload.sh first" >&2
    exit 1
}
BUILDER="${BUILDX_BUILDER:-mica-arm64}"
docker buildx inspect "${BUILDER}" >/dev/null 2>&1 ||
    docker buildx create --name "${BUILDER}" --driver docker-container >/dev/null

SNAPSHOT="$(bash "${REPO_ROOT}/tools/system-base.sh" sources-uri)"
mapfile -t TRIXIE_ARG < <(bash "${REPO_ROOT}/tools/from.sh" MICA_IMAGE_DEBIAN_TRIXIE=IMAGE_DEBIAN_TRIXIE)
[ "${#TRIXIE_ARG[@]}" -eq 2 ] || { echo "error: tools/from.sh did not resolve IMAGE_DEBIAN_TRIXIE" >&2; exit 1; }

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
