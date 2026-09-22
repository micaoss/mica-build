#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
command -v docker >/dev/null
mkdir -p _out/tests
image=$(bash bin/bun.sh src/cli.ts from --ref mica-build-env:c)
# mica-build-side: container-block -- compile and execute with the pinned C toolchain.
docker run --rm --label ai-agent=true --network traefik -v "$PWD:/src:ro" -v "$PWD/_out/tests:/out" \
    --entrypoint /bin/bash "$image" -ceu '
    gcc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined \
        /src/tests/suites/lifecycle-uboot-fit/records.c -o /out/fit-records
    timeout 15 /out/fit-records
'
# mica-build-side: host
