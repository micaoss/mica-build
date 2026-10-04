#!/usr/bin/env bash
# The BM201 front panel service (components/bm201-front-panel): its panel protocol and link icons, and its
# systemd unit, through the component's own suites.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../components/bm201-front-panel" && pwd)"
bash "$here/test-bm201-front-panel.sh"
bash "$here/test-bm201-front-panel-systemd.sh"
