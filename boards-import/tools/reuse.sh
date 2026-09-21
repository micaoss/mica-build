#!/usr/bin/env bash
# Whether a board component can be reused from the board's latest published
# release: prints that component's manifest digest when the manifest's
# mica.inputs annotation equals <inputs>, and nothing otherwise. Everything is
# read anonymously, as a consumer would.
#
#   bash tools/reuse.sh <board> <component> <inputs sha256> [<release tag to skip>]
#
# The latest release is the highest <board>.<YYYYMMDD-HHMM> tag with a
# mica-boards.lock asset (the one being published is skipped); its lock names
# the component's digest in its `board <board> <component> <arch> <reference>` row.
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
SLUG="${MICA_SOURCE_URL#https://github.com/}/${REPO_NAME}"
# Overridable so a test can serve releases from file://.
LIST_URL="${MICA_RELEASE_LIST:-https://api.github.com/repos/${SLUG}/releases?per_page=100}"
DOWNLOAD="${MICA_RELEASE_DOWNLOAD:-https://github.com/${SLUG}/releases/download}"
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# The listing is release metadata from the GitHub API, whose anonymous rate limit
# is shared by every job on a runner's address: a token, when the workflow
# hands it in (GITHUB_TOKEN, or GH_TOKEN as the publish step sets it), only raises
# that limit. The locks and artifacts are read anonymously.
auth=()
token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
case "${LIST_URL}" in https://api.github.com/*) [ -z "${token}" ] || auth=(-H "Authorization: Bearer ${token}") ;; esac
curl -fsSL "${auth[@]}" "${LIST_URL}" -o "${WORK}/releases.json" || die "listing the releases of ${SLUG} failed"
latest="$(jq -r --arg b "${BOARD}." --arg skip "${SKIP}" '[.[] | select(.draft == false and (.tag_name | startswith($b)) and .tag_name != $skip
    and ([.assets[].name] | index("mica-boards.lock")))] | map(.tag_name) | sort | last // empty' "${WORK}/releases.json")"
[ -n "${latest}" ] || exit 0
curl -fsSL "${DOWNLOAD}/${latest}/mica-boards.lock" -o "${WORK}/lock" || die "downloading mica-boards.lock of ${latest} failed"
reference="$(awk -F'\t' -v b="${BOARD}" -v c="${COMPONENT}" '$1 == "board" && $2 == b && $3 == c { print $5 }' "${WORK}/lock")"
[ -n "${reference}" ] || exit 0
digest="${reference##*@}"
status="$(REGISTRY_TOKEN='' oci_manifest_get "$(oci_repo "${REPO_NAME}")" "${digest}" "${WORK}/manifest.json")"
[ "${status}" = 200 ] && [ "$(oci_manifest_digest "${WORK}/manifest.json")" = "${digest}" ] || die "${reference} of ${latest} does not read anonymously (HTTP ${status})"
[ "$(jq -r '.annotations["mica.inputs"] // empty' "${WORK}/manifest.json")" = "${INPUTS}" ] || exit 0
printf '%s\n' "${digest}"
