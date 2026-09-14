#!/usr/bin/env bash
# Extract a composed factory root from its OCI archive into the scratch tree.
#   bash extract-root.sh <board> [<out-dir-of-that-board>]
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
S="${P1_WORK:-$REPO/.tmp/p1-writable-path-audit}"
mkdir -p "$S"
b="${1:?product}"
src="${2:-$REPO/_out/products/$b/build}/factory-root.oci"
[ -f "$src" ] || { echo "error: $src not found" >&2; exit 1; }
d="$S/oci-$b"; rm -rf "$d"; mkdir -p "$d"
tar -C "$d" -xf "$src"
man=$(jq -r '.manifests[0].digest' "$d/index.json" | cut -d: -f2)
lay=$(jq -r '.layers[0].digest' "$d/blobs/sha256/$man" | cut -d: -f2)
root="$S/root-$b"; rm -rf "$root"; mkdir -p "$root"
tar -C "$root" -xzf "$d/blobs/sha256/$lay"
echo "extracted $root"
