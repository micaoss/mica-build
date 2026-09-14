#!/usr/bin/env bash
# Shared paths, image names and the one docker helper the lab's entry scripts
# use. Sourced, never run.
#
# EVERY PATH IS RELATIVE TO THE CHECKOUT THAT RUNS IT. The lab was written
# against one worktree's absolute paths and that made it unrunnable anywhere
# else; the repository root is derived from this file's own location, and the
# artefacts it reads (kernels, roots, images) are named by the caller.
set -euo pipefail

LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${LAB_DIR}/../.." && pwd)"
[ -f "${REPO_ROOT}/Makefile" ] || {
    echo "error: ${REPO_ROOT}/Makefile does not exist, so ${REPO_ROOT} is not the repository root" >&2
    exit 1
}

# Scratch. Under _out/ because that is the directory this repository's builds
# write to and `make clean` removes; overridable for a run that wants its
# artefacts kept aside.
LAB_WORK="${MICA_LAB_WORK:-${REPO_ROOT}/_out/signed-boot-lab}"

# The three images this lab builds, by name. tests/signed-boot-lab/images.sh
# builds them; every entry script refuses rather than pulling, because
# `mica-signed-boot-*` exists in no registry and a failed pull reads as a
# network problem rather than a missing build step.
LAB_IMAGE=mica-signed-boot-lab:latest
GUEST_IMAGE=mica-signed-boot-guest:latest
UBOOT_IMAGE=mica-signed-boot-uboot:latest

lab_require_image() {
    docker image inspect "$1" >/dev/null 2>&1 || {
        echo "error: the image $1 is not in the local store. Build it: bash tests/signed-boot-lab/images.sh" >&2
        exit 1
    }
}

# `docker run` with this repository's conventions: labelled so an unattended
# sweep can find it, named so a concurrent run of another task's containers is
# not what gets removed, and the work directory mounted at /w.
lab_docker_run() {
    local image="$1"; shift
    docker run --rm --label ai-agent=true \
        --name "ai-agent-signed-boot-lab-$$-${RANDOM}" \
        -v "${LAB_WORK}:/w" -v "${LAB_DIR}:/lab:ro" \
        "${image}" "$@"
}

lab_note() { echo "signed-boot-lab: $*"; }
