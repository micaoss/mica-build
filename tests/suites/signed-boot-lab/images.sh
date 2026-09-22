#!/usr/bin/env bash
# Build the lab's container images by name, from the Dockerfiles beside this
# script.
#
#   bash tests/suites/signed-boot-lab/images.sh            the two the verity and UEFI
#                                                   proofs need
#   bash tests/suites/signed-boot-lab/images.sh --uboot    and the U-Boot sandbox
#
# Every image is labelled `ai-agent=true` so an unattended sweep can reclaim
# it, and every base image is resolved through tools/from.sh rather than
# written here: the Dockerfiles declare their FROM argument with no default, so
# a build that forgot one fails before any layer runs.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

WITH_UBOOT=0
[ "${1-}" = --uboot ] && WITH_UBOOT=1

# The one Debian archive the pinned mica-system-base release names.
SNAPSHOT="$(python3 "${REPO_ROOT}/tools/locks.py" rows apt mica-system-base | cut -f2)" && [ -n "${SNAPSHOT}" ] || {
    echo "error: locks/mica-system-base.lock yielded no apt archive, so the lab would install from wherever apt happens to point" >&2
    exit 1
}
# http and not https, and the substitution is here rather than in
# the apt row because that value is right for the build it serves. This base image carries no CA bundle, so the https form leaves apt
# with no package lists at all and every install reads as "Unable to locate
# package <everything>" -- measured. What protects the archive either way is
# its OpenPGP signature, checked against the debian-archive-keyring the base
# does carry; the transport is not the integrity mechanism here.
SNAPSHOT="${SNAPSHOT/https:\/\//http:\/\/}"
lab_note "apt snapshot: ${SNAPSHOT}"

mapfile -t TRIXIE_ARG < <(bash "${REPO_ROOT}/tools/from.sh" MICA_IMAGE_DEBIAN_TRIXIE=upstream:debian:trixie-slim)
[ "${#TRIXIE_ARG[@]}" -eq 2 ] || { echo "error: tools/from.sh did not resolve upstream:debian:trixie-slim" >&2; exit 1; }

build() {  # build <tag> <dockerfile> [extra args...]
    local tag="$1" file="$2"; shift 2
    lab_note "building ${tag} from ${file##*/}"
    docker build --label ai-agent=true -t "${tag}" -f "${LAB_DIR}/${file}" \
        "${TRIXIE_ARG[@]}" --build-arg "MICA_DEBIAN_SNAPSHOT=${SNAPSHOT}" \
        "$@" "${LAB_DIR}"
}

if [ "${1-}" = --lifecycle ]; then
    build ai-agent/mica-p2-lab Dockerfile.lab
    exit 0
fi

build "${LAB_IMAGE}" Dockerfile.lab
build "${GUEST_IMAGE}" Dockerfile.guest

if [ "${WITH_UBOOT}" = 1 ]; then
    mapfile -t UBUNTU_ARG < <(bash "${REPO_ROOT}/tools/from.sh" MICA_IMAGE_UBUNTU_2404=upstream:ubuntu:24.04)
    [ "${#UBUNTU_ARG[@]}" -eq 2 ] || { echo "error: tools/from.sh did not resolve upstream:ubuntu:24.04" >&2; exit 1; }
    lab_note "building ${UBOOT_IMAGE} from Dockerfile.uboot-sandbox (a full U-Boot build; minutes)"
    docker build --label ai-agent=true -t "${UBOOT_IMAGE}" \
        -f "${LAB_DIR}/Dockerfile.uboot-sandbox" "${UBUNTU_ARG[@]}" "${LAB_DIR}"
fi

lab_note "done"
