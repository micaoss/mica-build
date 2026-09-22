#!/usr/bin/env bash
# What this tree reads out of the imported mica-podman archives.
#
#   bash tools/podman-pool.sh --check      the engine's pins, and the arm64 quadlet, out of the pinned archives the pools hold
#
#   reads   _out/debs/<arch>/pool/mica-podman_*.deb   (fetched at the package row by tools/pool.sh)
#   writes  _out/debs/mica-podman/upstream.lock        (the archives' /usr/share/mica-podman/upstream.lock)
#           _out/debs/arm64/mica-podman/quadlet
#
# The container engine is built and released by micaoss/mica-podman; this
# repository imports the archives through the package rows of
# locks/mica-podman.lock and never sees that repository's tree. Four of its
# consumers still need two things out of it: the upstream trees the seven
# binaries were built from (the smoke register, the install-closure gate and
# the netavark kernel check compare what a binary reports against their git
# tags) and the aarch64 quadlet binary (tests/gates/quadlet-doc-test.sh runs the
# generator the image ships). The package carries the first as
# /usr/share/mica-podman/upstream.lock, which both architectures' archives
# must carry identically; the quadlet is taken when the arm64 pool holds its archive.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
POOL="${MICA_POOL_DIR:-${REPO_ROOT}/_out/debs}"
MEMBER="${HERE}/deb-member.py"
LOCK_PATH="usr/share/mica-podman/upstream.lock"
QUADLET_PATH="usr/libexec/podman/quadlet"

archive_for() { # <arch>: the one mica-podman archive of that pool, or nothing
    local arch="$1" found=()
    for f in "${POOL}/${arch}/pool/"mica-podman_*_"${arch}".deb; do
        [ -e "${f}" ] && found+=("${f}")
    done
    [ "${#found[@]}" -le 1 ] || { echo "error: ${#found[@]} mica-podman archives in ${POOL}/${arch}/pool; a pool holds one" >&2; exit 1; }
    printf '%s' "${found[0]:-}"
}

[ "${1:-}" = --check ] && [ "$#" -eq 1 ] || { echo "usage: bash tools/podman-pool.sh --check" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
read_from=""
for arch in amd64 arm64; do
    archive="$(archive_for "${arch}")"
    [ -n "${archive}" ] || continue
    python3 "${MEMBER}" "${archive}" "${LOCK_PATH}" "${work}/${arch}.lock"
    read_from="${read_from} ${arch}"
done
[ -n "${read_from}" ] || { echo "error: no mica-podman archive in ${POOL}/amd64/pool or ${POOL}/arm64/pool. locks/mica-podman.lock pins it; fetch it with \`make os-pool\`" >&2; exit 1; }
if [ -f "${work}/amd64.lock" ] && [ -f "${work}/arm64.lock" ] && ! cmp -s "${work}/amd64.lock" "${work}/arm64.lock"; then
    echo "error: the amd64 and arm64 mica-podman archives in ${POOL} carry different ${LOCK_PATH}; one release builds both from one set of trees" >&2
    diff -u "${work}/amd64.lock" "${work}/arm64.lock" >&2 || true
    exit 1
fi
mkdir -p "${POOL}/mica-podman"
cp "${work}/${read_from##* }.lock" "${POOL}/mica-podman/upstream.lock"
if [ -f "${work}/arm64.lock" ]; then
    python3 "${MEMBER}" "$(archive_for arm64)" "${QUADLET_PATH}" "${POOL}/arm64/mica-podman/quadlet"
fi
echo "podman-pool.sh: ${POOL#"${REPO_ROOT}"/}/mica-podman/upstream.lock from the${read_from} archive(s)$([ ! -f "${work}/arm64.lock" ] || echo "; arm64 quadlet at ${POOL#"${REPO_ROOT}"/}/arm64/mica-podman/quadlet")"
