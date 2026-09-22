#!/usr/bin/env bash
# Execute current publication refusals and the documented verification commands.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bash bin/bun.sh src/cli.ts test src/image/release-manifest.test.ts
