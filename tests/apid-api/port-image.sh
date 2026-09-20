#!/usr/bin/env bash
# The bun+docker-cli image the QEMU port runs in, named by its inputs.
#
# One spelling, because run.sh and tests/session-probe/run.sh both need it and
# a second copy of a tag derivation is a tag that drifts.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bun_image="$(bash tools/from.sh --ref mica-build-env:base)"
cli="$(bash tools/from.sh --ref upstream:docker:28-cli)"
printf 'ai-agent/mica-verify-bun:%s\n' "$(printf '%s\n%s\n' "${bun_image}" "${cli}" | sha256sum | cut -c1-16)"
