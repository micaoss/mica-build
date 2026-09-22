#!/usr/bin/env bash
# The bun+docker-cli image the QEMU port runs in, named by its inputs.
#
# One spelling, because run.sh and tests/suites/session-probe/run.sh both need it and
# a second copy of a tag derivation is a tag that drifts.
#
# --build builds it if it is not local. Nothing in `make build-env` builds this
# image, so a caller that assumes it exists finds it missing at exactly the
# moment it is needed -- which is a CI runner, where nothing has run before.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
bun_image="$(bash tools/from.sh --ref mica-build-env:base)"
cli="$(bash tools/from.sh --ref upstream:docker:28-cli)"
tag="ai-agent/mica-verify-bun:$(printf '%s\n%s\n' "${bun_image}" "${cli}" | sha256sum | cut -c1-16)"
if [ "${1:-}" = --build ] && ! docker image inspect "${tag}" >/dev/null 2>&1; then
    docker build -q --label ai-agent=true \
        --build-arg "MICA_BUN_IMAGE=${bun_image}" --build-arg "MICA_DOCKER_CLI_IMAGE=${cli}" \
        -t "${tag}" -f bin/Dockerfile bin >/dev/null
fi
printf '%s\n' "${tag}"
