#!/usr/bin/env bash
# Whether a board component can be reused from this repository's latest published
# release that carries it: prints that component's manifest digest when the
# manifest's mica.inputs annotation equals <inputs>, and nothing otherwise.
# Everything is read anonymously, as a consumer would.
#
#   bash tools/reuse.sh <board> <component> <inputs sha256> [<release tag to skip>]
#
# The latest release is the newest scoped release <scope>.<YYYYMMDD-HHMM> with a
# mica-build.lock asset whose lock carries a `board <board> <component> <arch>
# <reference>` row (a board-scoped release, or a product-scoped release of one of
# the board's products: both publish the board's components under their own tag,
# tools/deb/registry.sh latest_lock_with); the one being published is skipped.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
. "${REPO_ROOT}/tools/deb/registry.sh"
die() { echo "reuse.sh: error: $*" >&2; exit 1; }
[ "$#" -ge 3 ] && [ "$#" -le 4 ] || die "usage: bash tools/reuse.sh <board> <component> <inputs sha256> [<release tag to skip>]"
BOARD="$1" COMPONENT="$2" INPUTS="$3" SKIP="${4:-}"
[[ "${INPUTS}" =~ ^[0-9a-f]{64}$ ]] || die "'${INPUTS}' is not a sha256"

registry_load
registry_repo_name
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

latest_lock_with "${WORK}" board "${BOARD}" "${COMPONENT}" "${SKIP}" || exit 0
reference="$(awk -F'\t' -v b="${BOARD}" -v c="${COMPONENT}" '$1 == "board" && $2 == b && $3 == c { print $5 }' "${LATEST_LOCK}")"
[ -n "${reference}" ] || exit 0
digest="${reference##*@}"
status="$(REGISTRY_TOKEN='' oci_manifest_get "$(oci_repo "${REPO_NAME}")" "${digest}" "${WORK}/manifest.json")"
[ "${status}" = 200 ] && [ "$(oci_manifest_digest "${WORK}/manifest.json")" = "${digest}" ] || die "${reference} of ${LATEST_LABEL} does not read anonymously (HTTP ${status})"
[ "$(jq -r '.annotations["mica.inputs"] // empty' "${WORK}/manifest.json")" = "${INPUTS}" ] || exit 0
printf '%s\n' "${digest}"
