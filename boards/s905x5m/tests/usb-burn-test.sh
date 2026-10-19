#!/usr/bin/env bash
# The usb-burn image kind (boards/s905x5m/packer): its Amlogic v2 writer against a vector of the vendor
# packer, and pack/verify over a small eMMC layout (usb-burn-test.py).
set -euo pipefail
python3 -B "$(dirname "${BASH_SOURCE[0]}")/usb-burn-test.py" -v
