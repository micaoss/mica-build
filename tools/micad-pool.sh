#!/usr/bin/env bash
# What this tree reads out of the imported mica-apid archive.
#
#   bash tools/micad-pool.sh --openapi    the OpenAPI document into _out/debs/mica-apid/openapi.json
#   bash tools/micad-pool.sh --source     the mica-core source at the pinned commit into _out/src/mica-core
#
#   reads   _out/debs/amd64/pool/mica-apid_*.deb   (fetched at the pin by tools/pool.sh)
#   writes  _out/debs/mica-apid/openapi.json
#           _out/src/mica-core/                        (tools/source.sh)
#
# The management daemon and apid are built and released by micaoss/mica-core;
# this repository imports micad, mica-apid, mica-mqttd and mica-mqtt-broker
# through the package rows of locks/mica-core.lock and never sees that repository's tree. Two consumers
# still need something out of it:
#
# - tests/suites/apid-api/src/spec-pins.ts pins the API harness's phase literals
#   against the OpenAPI document, and the mica-apid archive ships that
#   document as /usr/share/mica-apid/openapi.json -- what the installed
#   apid answers, at the pinned commit, rather than a checkout that may be
#   ahead of or behind the archive (--openapi);
# - verify's connd family reads the wifi reconcilers' contract (unit names,
#   config paths, the sweep prefix) out of micad/src/reconciler/ rather than
#   restating it, so it needs that SOURCE at the pinned commit: --source
#   checks it out with tools/source.sh, at the commit every micad
#   pin names, into _out/src/mica-core. `make os-verify-test` and `make
#   os-verify` run it first; MICA_VERIFY_RECONCILER_DIR overrides the path.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
POOL="${MICA_POOL_DIR:-${REPO_ROOT}/_out/debs}"
MEMBER="${HERE}/deb-member.py"

case "${1:-}" in
--openapi)
    found=()
    for f in "${POOL}/amd64/pool/"mica-apid_*_amd64.deb; do
        [ -e "${f}" ] && found+=("${f}")
    done
    [ "${#found[@]}" -eq 1 ] || {
        echo "error: expected exactly one mica-apid archive in ${POOL}/amd64/pool, found ${#found[@]}. locks/mica-core.lock pins it; fetch it with \`bash tools/pool.sh fetch --arch amd64\` or \`make os-pool\`" >&2
        exit 1
    }
    python3 "${MEMBER}" "${found[0]}" "usr/share/mica-apid/openapi.json" "${POOL}/mica-apid/openapi.json"
    echo "micad-pool.sh: ${POOL#"${REPO_ROOT}"/}/mica-apid/openapi.json from ${found[0]##*/}"
    ;;
--source)
    bash "${REPO_ROOT}/tools/source.sh" mica-core
    [ -d "${REPO_ROOT}/_out/src/mica-core/crates/micad/src/reconciler" ] || {
        echo "error: _out/src/mica-core/crates/micad/src/reconciler does not exist at the mica-core commit of its release; verify's connd family reads the reconcilers' contract out of it" >&2
        exit 1
    }
    ;;
*)
    echo "usage: bash tools/micad-pool.sh --openapi | --source" >&2
    exit 1
    ;;
esac
