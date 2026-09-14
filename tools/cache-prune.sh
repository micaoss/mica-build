#!/usr/bin/env bash
# Reduce the download caches to what the current pins name before CI saves them.
#
#   bash tools/cache-prune.sh
#
# _out/cache/pool keeps the archives tools/pool.sh rows names, _out/cache/debian
# the archives of system-base-packages.lock and their control fields,
# _out/cache/oci the manifests and _out/cache/base-status the root statuses of
# system-base.lock; anything else -- a superseded pin, a partial download -- is
# removed, so a saved cache holds only third-party inputs of this commit. Every
# kept file is still hashed again by the step that reads it.
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
bash "${HERE}/pool.sh" rows | cut -f4 | sed 's/$/.deb/' | LC_ALL=C sort -u >"${keep}"
prune "${REPO_ROOT}/_out/cache/pool" "${keep}"
awk -F'\t' '!/^#/ && NF == 6 { print $4 ".deb"; print $4 ".control" }' "${REPO_ROOT}/system-base-packages.lock" | LC_ALL=C sort -u >"${keep}"
prune "${REPO_ROOT}/_out/cache/debian" "${keep}"
sed -n 's/^POOL_MICA_SYSTEM_BASE_[A-Z0-9]*=.*@\(sha256:[0-9a-f]*\)$/\1.json/p' "${REPO_ROOT}/system-base.lock" >"${keep}"
prune "${REPO_ROOT}/_out/cache/oci" "${keep}"
sed -n 's/^IMAGE_MICA_SYSTEM_BASE_ROOTFS_[A-Z0-9]*=.*@\(sha256:[0-9a-f]*\)$/\1/p' "${REPO_ROOT}/system-base.lock" >"${keep}"
prune "${REPO_ROOT}/_out/cache/base-status" "${keep}"
