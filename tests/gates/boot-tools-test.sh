#!/usr/bin/env bash
# The boot-tools image at work: the startup initramfs of the pinned mica-runkit
# packed twice to the same bytes, and the payload compression's refusals.
#
#   bash tests/gates/boot-tools-test.sh      (make os-boot-test; after make os-boot-tools and make os-pool)
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
IMAGE=ai-agent/mica-boot-tools-amd64
docker image inspect "${IMAGE}" >/dev/null 2>&1 || {
    echo "error: ${IMAGE} is not built; run make os-boot-tools" >&2
    exit 1
}
WORK="$(mktemp -d "${REPO_ROOT}/_out/.boot-tools-test.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
mkdir -p "${WORK}/input" "${WORK}/output"
bash bin/bun.sh src/cli.ts deploy-pool --lifecycle amd64 "${WORK}/input"
# initramfs.sh installs whatever boot.json the kernel component hands it.
printf '{}\n' >"${WORK}/input/boot.json"
run() {
    docker run --rm --label ai-agent=true --network none -v "${REPO_ROOT}:/src:ro" \
        -v "${WORK}/input:/input:ro" -v "${WORK}/output:/output" --entrypoint bash "${IMAGE}" "$@"
}
run /src/tests/gates/boot-initramfs-test.sh /src
run /src/tests/gates/boot-compression-test.sh
echo "RESULT: PASS (startup initramfs and payload compression in ${IMAGE})"
