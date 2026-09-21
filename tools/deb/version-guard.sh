#!/usr/bin/env bash
# The package-version guard: a board's freshly built pool against the board's
# latest published release (mica:docs/decisions/2026-09-15-package-versions.md
# R5). Read-only; run after `make pool`, in CI and in a board release's build.
#
#   bash tools/deb/version-guard.sh --board <board> [--release <board>.<YYYYMMDD-HHMM>]
#
#   reads   _out/debs/<arch>/pool/, the archives boards/boards.tsv lists for the board; the latest
#           <board>.* release other than --release: its mica-boards.lock and its pool manifest (anonymously)
#
# For every package of the board, against that release's package row:
#   the same version   its producer's inputs hash (tools/deb/package-inputs.sh) must equal the published
#                      layer's mica.inputs ("inputs of <package> changed without a version bump"), and the
#                      archive built here must be byte for byte the published one, downloaded at its digest;
#                      the release then publishes those same bytes, and an unchanged pool keeps its digest
#   a higher version   built and published (a bump)
#   a lower version    refused
#   not published      built and published
# A previous archive that is missing or does not match its row is refused, never
# silently rebuilt. With no previous release, or one from before these rules
# (pool layers without mica.inputs), there is nothing to compare and every
# archive is built.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
# shellcheck disable=SC1091
. "${HERE}/registry.sh"
die() { echo "version-guard.sh: error: $*" >&2; exit 1; }
usage="usage: bash tools/deb/version-guard.sh --board <board> [--release <board>.<YYYYMMDD-HHMM>]"

BOARD="" RELEASE=""
while [ "$#" -gt 0 ]; do
    case "$1" in
    --board) BOARD="${2-}"; shift 2 ;;
    --release) RELEASE="${2-}"; shift 2 ;;
    *) die "${usage}" ;;
    esac
done
[ -n "${BOARD}" ] || die "${usage}"
[ -z "${RELEASE}" ] || [ "${RELEASE%.*}" = "${BOARD}" ] || die "--release ${RELEASE} is not a release of ${BOARD}"
cd "${REPO_ROOT}"
ARCH="$(bash tools/boards.sh arch "${BOARD}")"
POOL="_out/debs/${ARCH}/pool"
[ -d "${POOL}" ] || die "${POOL} does not exist; run make pool first"

registry_load
registry_repo_name
ARTIFACT="$(oci_repo "${REPO_NAME}")"
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
previous="$(jq -r --arg b "${BOARD}." --arg skip "${RELEASE}" '[.[] | select(.draft == false and (.tag_name | startswith($b)) and .tag_name != $skip
    and ([.assets[].name] | index("mica-boards.lock")))] | map(.tag_name) | sort | last // empty' "${WORK}/releases.json")"
[ -n "${previous}" ] || { echo "version-guard.sh: ${BOARD} has no published release; every archive is built"; exit 0; }
curl -fsSL "${DOWNLOAD}/${previous}/mica-boards.lock" -o "${WORK}/lock" || die "downloading mica-boards.lock of ${previous} failed"
reference="$(awk -F'\t' -v a="${ARCH}" '$1 == "pool" && $2 == a { print $3 }' "${WORK}/lock")"
[ -n "${reference}" ] || die "mica-boards.lock of ${previous} has no ${ARCH} pool row"
status="$(REGISTRY_TOKEN='' oci_manifest_get "${ARTIFACT}" "${reference##*@}" "${WORK}/pool.json")"
[ "${status}" = 200 ] && [ "$(oci_manifest_digest "${WORK}/pool.json")" = "${reference##*@}" ] ||
    die "the pool ${reference} of ${previous} does not read anonymously at its digest (HTTP ${status})"
if ! jq -e '[.layers[] | .annotations["mica.inputs"] // "" | test("^[0-9a-f]{64}$")] | all' "${WORK}/pool.json" >/dev/null; then
    echo "version-guard.sh: ${previous} predates the package-version rules (its pool layers carry no mica.inputs); every archive is built"
    exit 0
fi

# -1, 0 or 1: Debian version order (deb-version(7)), without dpkg on the host.
vercmp() {
    python3 - "$1" "$2" <<'PY'
import sys
def order(c):
    return 0 if c.isdigit() else ord(c) if c.isalpha() else -1 if c == '~' else ord(c) + 256
def part(a, b):
    while a or b:
        i = 0
        while i < len(a) and not a[i].isdigit(): i += 1
        j = 0
        while j < len(b) and not b[j].isdigit(): j += 1
        sa, sb = a[:i], b[:j]
        for k in range(max(len(sa), len(sb))):
            ca = order(sa[k]) if k < len(sa) else 0
            cb = order(sb[k]) if k < len(sb) else 0
            if ca != cb: return (ca > cb) - (ca < cb)
        a, b = a[i:], b[j:]
        i = 0
        while i < len(a) and a[i].isdigit(): i += 1
        j = 0
        while j < len(b) and b[j].isdigit(): j += 1
        da, db = int(a[:i] or 0), int(b[:j] or 0)
        if da != db: return (da > db) - (da < db)
        a, b = a[i:], b[j:]
    return 0
def split(v):
    epoch, _, rest = v.rpartition(':') if ':' in v else ('0', '', v)
    up, _, rev = rest.rpartition('-') if '-' in rest else (rest, '', '0')
    return int(epoch or 0), up, rev
ea, ua, ra = split(sys.argv[1]); eb, ub, rb = split(sys.argv[2])
print((ea > eb) - (ea < eb) or part(ua, ub) or part(ra, rb))
PY
}

same=0 bumped=0 new=0
declare -A INPUTS=()
while read -r producer _dir arches packages _enablement; do
    case ",${arches}," in *",all,"*) build_arch=all ;; *) build_arch="${ARCH}" ;; esac
    inputs="$(bash tools/deb/package-inputs.sh "${producer}" "${build_arch}")"
    for p in ${packages//,/ }; do INPUTS["${p}"]="${inputs}"; done
done < <(bash tools/boards.sh producers "${BOARD}")

while IFS= read -r package; do
    mapfile -t debs < <(find "${POOL}" -maxdepth 1 -type f -name "${package}_*.deb")
    [ "${#debs[@]}" -eq 1 ] || die "${POOL} holds ${#debs[@]} archives of ${package}; build the pool with make pool"
    deb="${debs[0]}"
    version="$(python3 tools/deb/control-fields.py "${deb}" Version)"
    row="$(awk -F'\t' -v n="${package}" -v a="${ARCH}" '$1 == "package" && $2 == n && $3 == a { print $4 "\t" $5 }' "${WORK}/lock")"
    if [ -z "${row}" ]; then
        new=$((new + 1))
        echo "version-guard.sh: ${package} ${version}: not in ${previous}; built"
        continue
    fi
    IFS=$'\t' read -r published sha <<<"${row}"
    case "$(vercmp "${version}" "${published}")" in
    1)
        bumped=$((bumped + 1))
        echo "version-guard.sh: ${package} ${published} -> ${version}: bumped; built"
        continue
        ;;
    -1) die "${package} is ${version} here, lower than ${published} in ${previous}; a version never goes back" ;;
    esac
    layer="$(jq -r --arg d "sha256:${sha}" '.layers[] | select(.digest == $d) | [.annotations["org.opencontainers.image.title"], .annotations["mica.inputs"]] | @tsv' "${WORK}/pool.json")"
    [ -n "${layer}" ] || die "${package} ${published} (sha256 ${sha}) of ${previous}'s lock is no layer of its pool ${reference}"
    IFS=$'\t' read -r title published_inputs <<<"${layer}"
    [ "${title}" = "$(basename "${deb}")" ] || die "the published layer of ${package} ${published} is titled ${title}, and this build names it $(basename "${deb}")"
    [ "${published_inputs}" = "${INPUTS[${package}]}" ] ||
        die "inputs of ${package} changed without a version bump: ${published} was published by ${previous} with inputs ${published_inputs}, and they are ${INPUTS[${package}]} here. Bump its version in its version.env"
    status="$(REGISTRY_TOKEN='' oci_blob_get "${ARTIFACT}" "sha256:${sha}" "${WORK}/published.deb")"
    [ "${status}" = 200 ] || die "${title} of ${previous} does not download anonymously at sha256:${sha} (HTTP ${status})"
    [ "$(sha256sum "${WORK}/published.deb" | cut -d' ' -f1)" = "${sha}" ] || die "${title} of ${previous} downloads with another sha256 than its lock row ${sha}"
    cmp -s "${deb}" "${WORK}/published.deb" ||
        die "${package} ${version} built here is not the published archive of ${previous} (sha256 $(sha256sum "${deb}" | cut -d' ' -f1) here, ${sha} published) although its inputs are unchanged; its bytes moved (a toolchain or upstream change), so bump its version"
    same=$((same + 1))
    echo "version-guard.sh: ${package} ${version}: unchanged since ${previous}, byte-identical to the published archive"
done < <(bash tools/boards.sh packages "${BOARD}")

echo "version-guard.sh: ${BOARD} ${ARCH} against ${previous}: ${same} unchanged, ${bumped} bumped, ${new} new"
