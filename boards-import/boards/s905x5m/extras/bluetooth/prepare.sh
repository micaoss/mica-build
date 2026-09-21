#!/usr/bin/env bash
# Compile the board-owned bridge with the pinned target userspace toolchain.
set -euo pipefail
[ "$MICA_DEB_ARCH" = arm64 ]
make -C "$MICA_DEB_REPO_ROOT/boards/s905x5m" userland
cp -a "$MICA_DEB_REPO_ROOT/_out/s905x5m/userland/." "$MICA_DEB_STAGE/"
