#!/usr/bin/env bash
# The FIT loaders' redundant-environment entry (common/uboot/mica-records.h):
# common/uboot/tests/env-test.c compiled with sanitizers and run in
# the mica-build-env c image.
#
#   bash tests/uboot-env-test.sh          (docker)
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null 2>&1 || { echo "error: docker is required" >&2; exit 1; }
image="$(bash tools/from.sh --ref c)"
docker run --rm --label ai-agent=true --network none -v "$(pwd)/common/uboot:/src:ro" "${image}" \
    sh -ec 'gcc -std=gnu11 -Wall -Wextra -Werror -fsanitize=address,undefined -o /tmp/env-test /src/tests/env-test.c && /tmp/env-test'
