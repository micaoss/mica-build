#!/usr/bin/env bash
# The S905X5M's kconfig edit over the committed config: no in-kernel headers
# archive, which the image has no reader for and which costs size.
#
#   configure.sh <source-tree>
set -euo pipefail
cd "$1"
scripts/config --disable IKHEADERS
