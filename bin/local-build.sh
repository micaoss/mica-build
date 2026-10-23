#!/usr/bin/env bash
# A product built from local source checkouts and staged for hardware, nothing published (src/offline/local-build.ts,
# docs/local-build.md).
#
#   bin/local-build.sh <product> [--core <dir>] [--pkgs <dir>] [--podman <dir>] [--docker <dir>] [--base <dir>]
#                      [--env <dir>] [--tools <dir>] [--build] [--no-gates]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${HERE}/bun.sh" src/cli.ts local-build "$@"
