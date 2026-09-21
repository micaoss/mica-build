#!/usr/bin/env bash
# Validate a fresh factory image, then read back every written byte before reset.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
command -v python3 >/dev/null
if [ "${1:-}" = --check ]; then
    [ "$#" -eq 2 ] || exit 2
    exec python3 "$here/verify-flash.py" check "$2"
fi
[ "$#" -eq 1 ] || { echo 'usage: verify-flash.sh [--check] IMAGE' >&2; exit 2; }
image=$1
python3 "$here/verify-flash.py" check "$image"
rk=${RKDEVELOPTOOL:-rkdeveloptool}
command -v "$rk" >/dev/null
scratch=$(mktemp "$(dirname "$image")/.verify-flash.XXXXXX")
trap 'echo "Readback retained at $scratch" >&2' ERR
head_sectors=36864
sectors=$((1299 * 2048))
"$rk" rl 0 "$head_sectors" "$scratch"
python3 "$here/verify-flash.py" compare "$image" "$scratch" 0 "$((head_sectors * 512))"
"$rk" rl "$head_sectors" "$((sectors - head_sectors))" "$scratch"
python3 "$here/verify-flash.py" compare "$image" "$scratch" "$((head_sectors * 512))" "$(((sectors - head_sectors) * 512))"
rm -f "$scratch"
echo "Verified all $((sectors * 512)) written bytes; firmware and counter region first."
