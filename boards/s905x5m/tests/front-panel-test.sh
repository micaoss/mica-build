#!/usr/bin/env bash
# The BM201 front panel service (components/bm201-front-panel): its panel protocol and link icons, and its
# systemd unit, through the component's own suites.
#
# Under dash, the /bin/sh they are written for: bash reports a killed background job ("Killed") on the
# script's stderr, which one case asserts holds a single line, and a harness kill then races it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/../components/bm201-front-panel" && pwd)"
shell=$(command -v dash || command -v sh)
"$shell" "$here/test-bm201-front-panel.sh"
"$shell" "$here/test-bm201-front-panel-systemd.sh"
