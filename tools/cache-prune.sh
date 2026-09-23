#!/usr/bin/env bash
# Reduce the download caches to what the current pins name before CI saves them.
#
#   bash tools/cache-prune.sh
#
# _out/cache/pool keeps the archives src/cli.ts pool rows names, _out/cache/debian
# the upstream archives of locks/mica-system-base.lock and their control fields,
# _out/cache/oci the manifests of the pool and board rows of locks/,
# _out/cache/boards the layers of those board artifacts, and
# _out/cache/base-status the root statuses of the mica-system-base rootfs rows;
# anything else -- a superseded pin, a partial download -- is removed, so a saved
# cache holds only third-party inputs of this commit. Every kept file is still
# hashed again by the step that reads it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
[ "$#" -eq 0 ] || { echo "usage: bash tools/cache-prune.sh" >&2; exit 64; }

prune() { # <dir> <file of names to keep>
    local dir="$1" keep="$2" f removed=0
    [ -d "${dir}" ] || return 0
    for f in "${dir}"/*; do
        [ -e "${f}" ] || continue
        grep -Fx -- "${f##*/}" "${keep}" >/dev/null || { rm -rf "${f}"; removed=$((removed + 1)); }
    done
    echo "cache-prune.sh: ${dir#"${REPO_ROOT}"/}: ${removed} removed, $(find "${dir}" -mindepth 1 -maxdepth 1 | wc -l) kept"
}

keep="$(mktemp)"
trap 'rm -f "${keep}"' EXIT
bash "${HERE}/../bin/bun.sh" src/cli.ts pool rows | cut -f4 | sed 's/$/.deb/' | LC_ALL=C sort -u >"${keep}"
prune "${REPO_ROOT}/_out/cache/pool" "${keep}"
bash "${HERE}/../bin/bun.sh" src/cli.ts locks rows upstream mica-system-base | awk -F'\t' '{ print $5 ".deb"; print $5 ".control" }' | LC_ALL=C sort -u >"${keep}"
prune "${REPO_ROOT}/_out/cache/debian" "${keep}"
# The pool manifests the locks name, and the manifests of reused board components (src/cli.ts board-pool reads
# them by the digest the latest release publishes, which no lock here names): a component manifest is kept
# when it is the one a cached board layer came from, so the two caches are pruned together, newest kept.
bash "${HERE}/../bin/bun.sh" src/cli.ts locks rows pool | cut -f3 | sed 's/^.*@//; s/$/.json/' | LC_ALL=C sort -u >"${keep}"
for manifest in "${REPO_ROOT}"/_out/cache/oci/*.json; do
    [ -f "${manifest}" ] || continue
    [ "$(jq -r '.artifactType // ""' "${manifest}")" != "${manifest##*/}" ] || true
    case "$(jq -r '.artifactType // ""' "${manifest}")" in application/vnd.mica.board.*) basename "${manifest}" >>"${keep}" ;; esac
done
LC_ALL=C sort -u -o "${keep}" "${keep}"
prune "${REPO_ROOT}/_out/cache/oci" "${keep}"
for manifest in "${REPO_ROOT}"/_out/cache/oci/*.json; do
    [ -f "${manifest}" ] || continue
    case "$(jq -r '.artifactType // ""' "${manifest}")" in application/vnd.mica.board.*) jq -r '.layers[].digest | ltrimstr("sha256:")' "${manifest}" ;; esac
done | LC_ALL=C sort -u >"${keep}"
prune "${REPO_ROOT}/_out/cache/boards" "${keep}"
bash "${HERE}/../bin/bun.sh" src/cli.ts locks rows image mica-system-base | awk -F'\t' '$4 != "index" { sub(/^.*@/, "", $5); print $5 }' >"${keep}"
prune "${REPO_ROOT}/_out/cache/base-status" "${keep}"
