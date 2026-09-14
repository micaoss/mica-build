#!/usr/bin/env bash
# Offline target trees; no target executable, compiler, network or image build.
set -euo pipefail
command -v python3 >/dev/null
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
python3 "$ROOT/tests/rootfs-runtime/composition_test.py"
python3 "$ROOT/tests/rootfs-runtime/source_lineage_test.py"
bash "$ROOT/tests/rootfs-reproducibility-test.sh"
