#!/usr/bin/env bash
# mica-build-side: container -- runs only in the mica-build-env base image, from src/release/scoped.ts:
# the deterministic gzip of a raw image, compressed twice to the same bytes, and its decompressed identity.
#
#   bash /compress.sh <raw file name under /raw> <gz file name under /out>
#   -> "nondeterministic" when the two compressions differ, else "<sha256 of the decompressed bytes> <their size>"
set -euo pipefail
gzip -n -9 -c "/raw/$1" >"/out/$2.first"
gzip -n -9 -c "/raw/$1" >"/out/$2"
cmp -s "/out/$2.first" "/out/$2" || { echo nondeterministic; exit 0; }
rm "/out/$2.first"
chmod 0644 "/out/$2"
echo "$(gzip -dc "/out/$2" | sha256sum | cut -d' ' -f1) $(gzip -dc "/out/$2" | wc -c)"
