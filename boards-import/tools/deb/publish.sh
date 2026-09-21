#!/usr/bin/env bash
# Publish one board's archives as its pool artifact: the release's board.
#
#   bash tools/deb/publish.sh [--pool <dir>]
#
#   reads   <pool>/<arch>/pool/<package>_*.deb   (default pool: _out/debs) for every package
#           boards/boards.tsv lists for the board, at the board's architecture
#   writes  <registry>/<this repository>:pool.<board>.<arch>.<YYYYMMDD-HHMM>, one layer
#           per archive (application/vnd.mica.deb, titled with the archive's name and annotated
#           with its producer's inputs hash as mica.inputs, tools/deb/package-inputs.sh), and
#           only the manifest annotations mica.source-repo and mica.arch;
#           the pool and package rows of the release lock (registry.sh LOCK_ROWS)
#
# A pool manifest carries nothing about the release, so a pool whose archives
# are the published ones (tools/deb/version-guard.sh holds an unchanged version
# to its published bytes) is the published manifest under a new tag.
#
# The release is the tag <board>.<YYYYMMDD-HHMM> HEAD carries (MICA_RELEASE_TAG
# names it); an `all` archive the board lists is a layer of its pool. Refused: a
# checkout that is not a clean release, a listed package without exactly one
# archive, an archive not at its producer's declared version, archives from
# another repository.
# A tag that already exists must hold exactly the manifest this build pushes
# (its digest); the manifest and every blob are read back anonymously.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
# shellcheck disable=SC1091
. "${HERE}/registry.sh"

POOL_ROOT="${REPO_ROOT}/_out/debs"
while [ "$#" -gt 0 ]; do
    case "$1" in
    --pool) POOL_ROOT="${2-}"; [ -n "${POOL_ROOT}" ] || { echo "error: --pool takes a directory" >&2; exit 1; }; shift 2 ;;
    *) echo "usage: bash tools/deb/publish.sh [--pool <dir>]" >&2; exit 1 ;;
    esac
done
for t in curl sha256sum python3 git jq; do
    command -v "${t}" >/dev/null 2>&1 || { echo "error: ${t} is required and not on PATH" >&2; exit 1; }
done

registry_load
registry_repo_name
registry_token --write

release_load
BOARD="${RELEASE_BOARD}"
ARCHES=("$(bash "${REPO_ROOT}/tools/boards.sh" arch "${BOARD}")")
FIELDS="python3 ${HERE}/control-fields.py"

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
# The rows describe exactly what this run published.
mkdir -p "${LOCK_ROWS}"
: >"${LOCK_ROWS}/pool.tsv"
: >"${LOCK_ROWS}/package.tsv"

published=0
present=0
for a in "${ARCHES[@]}"; do
    pool="${POOL_ROOT}/${a}/pool"
    [ -d "${pool}" ] || { echo "error: ${pool} does not exist; build the pool first (make pool POOL_BOARD=${BOARD})" >&2; exit 1; }
    bash "${REPO_ROOT}/tools/boards.sh" pool-has "${BOARD}" "${pool}" || exit 1
    DEBS=()
    while IFS= read -r p; do DEBS+=("$(find "${pool}" -maxdepth 1 -type f -name "${p}_*.deb")"); done < <(bash "${REPO_ROOT}/tools/boards.sh" packages "${BOARD}")
    mapfile -t DEBS < <(printf '%s\n' "${DEBS[@]}" | LC_ALL=C sort)

    # Refusals first, so a run publishes all or nothing.
    declare -A INPUTS=() DECLARED=()
    while read -r producer _dir arches packages _enablement; do
        case ",${arches}," in *",all,"*) build_arch=all ;; *",${a},"*) build_arch="${a}" ;; *) continue ;; esac
        inputs="$(bash "${HERE}/package-inputs.sh" "${producer}" "${build_arch}")" || exit 1
        read -r declared _epoch < <(bash "${HERE}/producers.sh" --version-for "${producer}") || exit 1
        for p in ${packages//,/ }; do INPUTS["${p}"]="${inputs}"; DECLARED["${p}"]="${declared}"; done
    done < <(bash "${REPO_ROOT}/tools/boards.sh" producers "${BOARD}")
    : >"${WORK}/layers-${a}.tsv"
    for deb in "${DEBS[@]}"; do
        n="$(basename "${deb}")"
        mapfile -t got < <(${FIELDS} "${deb}" Package Version Mica-Source-Repo)
        package="${got[0]:-}"; version="${got[1]:-}"; repo="${got[2]:-}"
        [ -n "${INPUTS[${package}]:-}" ] || { echo "error: no producer of ${BOARD} declares ${package}" >&2; exit 1; }
        [ "${version}" = "${DECLARED[${package}]}" ] || {
            echo "error: ${n} is versioned ${version}, and its producer declares ${DECLARED[${package}]} (version.env). Rebuild the pool" >&2
            exit 1
        }
        [ "${repo}" = "${REPO_NAME}" ] || {
            echo "error: ${n} says Mica-Source-Repo: ${repo:-(none)}, and this checkout is ${REPO_NAME}. Only this repository's own archives are published under its artifacts" >&2
            exit 1
        }
        printf '%s\t%s\t%s\t%s\n' "${deb}" application/vnd.mica.deb "${n}" "${INPUTS[${package}]}" >>"${WORK}/layers-${a}.tsv"
    done

    # The manifest is release-independent (pool_annotations, layers in name
    # order), so a pool whose archives did not change is the same manifest and
    # this release's tag lands on the published digest.
    artifact="$(pool_repo "${REPO_NAME}")"; ref="$(pool_tag "${BOARD}" "${a}" "${RELEASE_STAMP}")"
    pool_annotations "${REPO_NAME}" "${a}" "${WORK}/annotations-${a}.json"
    line="$(oci_publish "${artifact}" "${ref}" application/vnd.mica.pool "${WORK}/annotations-${a}.json" "${WORK}/layers-${a}.tsv")" || exit 1
    digest="${line#* }"
    if [ "${line%% *}" = pushed ]; then
        published=$((published + ${#DEBS[@]}))
        echo "publish.sh: ${#DEBS[@]} archive(s) pushed as ${OCI_HOST}/${artifact}:${ref} (${digest})"
    else
        present=$((present + ${#DEBS[@]}))
        echo "publish.sh: ${OCI_HOST}/${artifact}:${ref} already holds this pool (${digest})"
    fi

    # Public, always: a private package is a consumer's 401 later. Read back
    # with no credential: the tag resolves to this manifest, every blob to its bytes.
    oci_require_public "${artifact}" "${ref}" || exit 1
    status="$(REGISTRY_TOKEN='' oci_manifest_get "${artifact}" "${ref}" "${WORK}/back-${a}.json")"
    [ "${status}" = 200 ] && [ "$(oci_manifest_digest "${WORK}/back-${a}.json")" = "${digest}" ] ||
        { echo "error: ${OCI_HOST}/${artifact}:${ref} does not read back anonymously as ${digest} (HTTP ${status})" >&2; exit 1; }
    printf '%s\t%s\t%s\n' "${a}" "${ref}" "${digest}" >>"${LOCK_ROWS}/pool.tsv"
    for deb in "${DEBS[@]}"; do
        n="$(basename "${deb}")"
        sha="$(sha256sum "${deb}" | cut -d' ' -f1)"
        status="$(REGISTRY_TOKEN='' oci_blob_get "${artifact}" "sha256:${sha}" "${WORK}/back.deb")"
        [ "${status}" = 200 ] || { echo "error: reading ${n} back anonymously from ${OCI_HOST}/${artifact} answered HTTP ${status}; the registry does not serve what it accepted" >&2; exit 1; }
        got="$(sha256sum "${WORK}/back.deb" | cut -d' ' -f1)"
        [ "${got}" = "${sha}" ] || { echo "error: the registry serves ${n} with sha256 ${got}, and the archive here is ${sha}" >&2; exit 1; }
        mapfile -t got < <(${FIELDS} "${deb}" Package Version)
        printf '%s\t%s\t%s\t%s\n' "${got[0]}" "${a}" "${got[1]}" "${sha}" >>"${LOCK_ROWS}/package.tsv"
    done
done

echo "publish.sh: ${published} archive(s) pushed, ${present} already present, all read back at their digests; ${OCI_HOST}/$(pool_repo "${REPO_NAME}"):pool.${BOARD}.<arch>.${RELEASE_STAMP}"
