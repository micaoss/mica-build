#!/usr/bin/env bash
# What this tree takes out of the imported mica-deploy archives and source.
#
#   bash tools/deploy-pool.sh --lifecycle <amd64|arm64> <dir>   mica-runkit into <dir>
#   bash tools/deploy-pool.sh --check                          the contract fixtures against the pinned source
#
#   reads   _out/debs/<arch>/pool/mica-lifecycle_*.deb   (fetched at the pin by tools/pool.sh)
#           _out/src/mica-core/                          (tools/source.sh, at the commit of its release)
#   writes  <dir>/mica-runkit                             (--lifecycle)
#
# The native boot and deployment tools are built and released by
# micaoss/mica-core; this repository imports mica-deploy (the device-side
# client, installed into every root) and mica-lifecycle (the static
# mica-runkit the signed kernel carries) through locks/mica-core.lock and never
# sees that repository's tree except at its release commit. Two consumers still need something out of it:
#
# - build/src/kernel-package.ts packs mica-runkit into the initramfs, as /init
#   and the exit ramdisk's shutdown, where it is part of the authenticated
#   kernel identity. --lifecycle reads it out of the pinned archive of the
#   board's architecture (tools/deb-member.py), so the kernel is built from
#   the binaries the pin names and nothing is compiled here.
# - tests/component-contracts/ is the contract between build/ (the producer
#   of envelopes and records) and the crate's reader; both repositories
#   commit the same four files. --check reads mica-deploy's copy at the
#   locked commit and refuses a difference, so the two cannot drift apart
#   without a bump on one side and a diff on the other. `make os-pool` runs
#   it beside the fetch, where the network is already required.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
POOL="${MICA_POOL_DIR:-${REPO_ROOT}/_out/debs}"
MEMBER="${HERE}/deb-member.py"

archive_for() {
    local arch="$1" found=()
    for f in "${POOL}/${arch}/pool/"mica-lifecycle_*_"${arch}".deb; do
        [ -e "${f}" ] && found+=("${f}")
    done
    [ "${#found[@]}" -eq 1 ] || {
        echo "error: expected exactly one mica-lifecycle archive in ${POOL}/${arch}/pool, found ${#found[@]}. locks/mica-core.lock pins it; fetch it with \`make os-pool\`" >&2
        exit 1
    }
    printf '%s\n' "${found[0]}"
}

case "${1:-}" in
--lifecycle)
    arch="${2:-}"; dir="${3:-}"
    case "${arch}" in amd64 | arm64) ;; *) echo "usage: bash tools/deploy-pool.sh --lifecycle <amd64|arm64> <dir>" >&2; exit 1 ;; esac
    [ -n "${dir}" ] || { echo "usage: bash tools/deploy-pool.sh --lifecycle <amd64|arm64> <dir>" >&2; exit 1; }
    archive="$(archive_for "${arch}")"
    mkdir -p "${dir}"
    python3 "${MEMBER}" "${archive}" usr/lib/mica/lifecycle/mica-runkit "${dir}/mica-runkit"
    echo "deploy-pool.sh: mica-runkit for ${arch} in ${dir} from ${archive##*/}"
    ;;
--check)
    bash "${REPO_ROOT}/tools/source.sh" mica-core
    theirs="${REPO_ROOT}/_out/src/mica-core/crates/mica-deploy/tests/component-contracts"
    ours="${REPO_ROOT}/tests/component-contracts"
    [ -d "${theirs}" ] || { echo "error: ${theirs#"${REPO_ROOT}"/} does not exist at the mica-core commit of its release; the contract fixtures are expected there" >&2; exit 1; }
    diff -ruN "${ours}" "${theirs}" || {
        echo "error: tests/component-contracts differs from mica-core's copy at the commit of its release (see the diff above). The files are one contract read by both sides; change them in mica-core, release, move the pins here, and copy the same files" >&2
        exit 1
    }
    echo "deploy-pool.sh: tests/component-contracts matches mica-core crates/mica-deploy at the commit of its release"
    ;;
*)
    echo "usage: bash tools/deploy-pool.sh --lifecycle <amd64|arm64> <dir> | --check" >&2
    exit 1
    ;;
esac
