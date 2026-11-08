#!/usr/bin/env bash
# The gce image kind (boards/uefi-x64/packer/gce): pack/verify over a small GPT disk (gce-test.py).
set -euo pipefail
python3 -B "$(dirname "${BASH_SOURCE[0]}")/gce-test.py" -v
