#!/usr/bin/env bash
# Execute current publication refusals and the documented verification commands.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
bash build/run.sh ./src/release-manifest.test.ts
