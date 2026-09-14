#!/usr/bin/env bash
# The imported package pool: pins, releases, fetch and index.
#
#   bash tools/pool.sh rows [--arch <amd64|arm64>]
#       every pinned archive as a row: package, version, architecture, sha256, repository, commit, asset
#   bash tools/pool.sh fetch --arch <amd64|arm64> [--packages "<p> ..."] [--check]
#       download and verify the pinned archives into _out/debs/<arch>/pool
#       (--check reads the release listing or the pool manifest only)
#   bash tools/pool.sh index --arch <amd64|arm64>
#       Packages, SHA256SUMS and manifest.txt over _out/debs/<arch>/pool
#
#   reads   deps/packages/<package>.json   the pin: name, repository, commit and, per
#                                          architecture, version, architecture, sha256, asset
#           deps/releases/<repository>.json where the repository's archives are published
#             (transport github-release): release, commit, url, sha256sums (the sha256 of
#             that release's SHA256SUMS); an asset is refused unless SHA256SUMS hashes
#             to that value and lists the asset at the pinned sha256
#             (transport oci): release, commit, url, sha256sums as above, and pools
#             {amd64, arm64} and boards {<board>} (ghcr.io references by digest,
#             tools/board-pool.sh reads the boards); an archive is a layer of its pool
#             manifest, found by digest and by its title <package>_<version>_<arch>.deb,
#             and SHA256SUMS must list it under that title at the pinned sha256
#           system-base.lock               the mica-system-base pools, whose archives are rows
#                                          of their own (tools/system-base.sh rows)
#   writes  _out/debs/<arch>/pool/*.deb, _out/debs/<arch>/{Packages,SHA256SUMS,manifest.txt},
#           _out/cache/pool/<sha256>.deb (the download cache; a cached archive is hashed again)
#
# A reader reads only the location its release names: a refused token, 404,
# transport failure, wrong identity or hash mismatch stops it, with no
# fallback. Every archive is also read for its control fields, which must equal
# the pin. MICA_POOL_DIR overrides _out/debs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
PINS="${MICA_LOCK_DIR:-${REPO_ROOT}/deps/packages}"
RELEASES="${MICA_RELEASE_DIR:-${REPO_ROOT}/deps/releases}"
POOL_ROOT="${MICA_POOL_DIR:-${REPO_ROOT}/_out/debs}"
CACHE="${MICA_POOL_CACHE:-${REPO_ROOT}/_out/cache/pool}"

die() { echo "pool.sh: error: $*" >&2; exit 1; }
for t in curl jq sha256sum; do
    command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"
done

# One validated TSV row per pin and target.
rows() { # [arch]
    local want="${1:-}" file
    [ -d "${PINS}" ] || die "${PINS} does not exist"
    { for file in "${PINS}"/*.json; do
        [ -e "${file}" ] || continue
        jq -e --arg stem "$(basename "${file}" .json)" '
            type == "object" and (keys | sort) == ["commit", "name", "repository", "targets"]
            and .name == $stem and (.name | test("^[a-z0-9][a-z0-9+.-]+$"))
            and (.repository | test("^[A-Za-z0-9][A-Za-z0-9._-]*$")) and (.commit | test("^[0-9a-f]{40}$"))
            and (.targets | type == "object" and length > 0 and (keys - ["amd64", "arm64"] | length == 0))
            and ([.targets | to_entries[] | .key as $pool | .value
                  | (type == "object" and (keys | sort) == ["architecture", "asset", "sha256", "version"])
                    and (.architecture == $pool or .architecture == "all")
                    and (.version | test("^([0-9][A-Za-z0-9.~]*\\+git[0-9a-f]{12}|[0-9]{8}-[0-9]{4})-[1-9][0-9]*$"))
                    and (.sha256 | test("^[0-9a-f]{64}$"))
                    and (.asset == (($stem + "_" + .version + "_" + .architecture + ".deb") | gsub("\\+"; "."))
                         or .asset == ($stem + "_" + .version + "_" + .architecture + ".deb"))]
                 | all)' "${file}" >/dev/null 2>&1 ||
            die "${file} is not a package pin: name (the file name), repository, a 40-hex commit and targets keyed amd64/arm64, each with version, architecture (the pool's or all), sha256 and asset"
        jq -r '.name as $n | .repository as $r | .commit as $c | .targets | to_entries[] | .value | [$n, .version, .architecture, .sha256, $r, $c, .asset] | @tsv' "${file}"
    done
    bash "${HERE}/system-base.sh" rows ${want:+--arch "${want}"} || die "the mica-system-base pools could not be read (see above)"
    } | LC_ALL=C sort -u | awk -F'\t' -v want="${want}" '
        { key = $1 "\t" $3; if (key in seen) { printf "pool.sh: error: %s is pinned twice for %s\n", $1, $3 > "/dev/stderr"; exit 1 }
          seen[key] = 1; if (want == "" || $3 == want || $3 == "all") print }'
}

release_field() { # <repository> <jq filter>
    local file="${RELEASES}/$1.json"
    [ -f "${file}" ] || die "${file} does not exist: nothing says where ${1}'s archives are published"
    jq -er "$2" "${file}" 2>/dev/null || die "${file} gives no $2"
}

check_release() { # <repository> <commit>
    local file="${RELEASES}/$1.json" transport
    [ -f "${file}" ] || die "${file} does not exist: nothing says where ${1}'s archives are published"
    transport="$(release_field "$1" .transport)"
    case "${transport}" in
    github-release)
        jq -e '(keys | sort) == ["commit", "release", "repository", "sha256sums", "transport", "url"]
            and (.release | test("^[0-9]{8}-[0-9]{4}$")) and (.commit | test("^[0-9a-f]{40}$"))
            and (.sha256sums | test("^[0-9a-f]{64}$")) and (.url | test("^https://github\\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/releases/download/[0-9]{8}-[0-9]{4}/$"))' "${file}" >/dev/null ||
            die "${file} is not a github-release record: repository, release, commit, url (…/releases/download/<release>/), sha256sums"
        ;;
    oci)
        jq -e '.release as $r
            | ((.url // "") | capture("^https://github\\.com/(?<o>[a-z0-9-]+)/(?<n>[A-Za-z0-9._-]+)/releases/download/[0-9]{8}-[0-9]{4}/$")) as $u
            | ("^ghcr\\.io/" + $u.o + "/" + $u.n + ":") as $at
            | (keys | sort) == ["boards", "commit", "pools", "release", "repository", "sha256sums", "transport", "url"]
            and ($r | test("^[0-9]{8}-[0-9]{4}$")) and (.url | endswith("/" + $r + "/")) and $u.n == .repository
            and (.commit | test("^[0-9a-f]{40}$")) and (.sha256sums | test("^[0-9a-f]{64}$"))
            and (.pools | type == "object" and (keys | sort) == ["amd64", "arm64"])
            and ([.pools | to_entries[] | .key as $k | .value | test($at + "pool\\." + $k + "\\." + $r + "@sha256:[0-9a-f]{64}$")] | all)
            and (.boards | type == "object" and length > 0)
            and ([.boards | to_entries[] | .key as $k | ($k | test("^[a-z0-9][a-z0-9-]*$")) and (.value | test($at + "board\\." + $k + "\\." + $r + "@sha256:[0-9a-f]{64}$"))] | all)' "${file}" >/dev/null 2>&1 ||
            die "${file} is not an oci record: repository, release, commit, url (https://github.com/<owner>/<repository>/releases/download/<release>/), sha256sums, pools {amd64, arm64} and boards {<board>} as ghcr.io/<owner>/<repository>:pool.<arch>.<release>|board.<board>.<release>@sha256:<digest>"
        ;;
    *) die "${file} names the transport '${transport}'; github-release and oci are read" ;;
    esac
    [ "$(release_field "$1" .repository)" = "$1" ] || die "${file} is not the record of $1"
    [ "$(release_field "$1" .commit)" = "$2" ] || die "the pins of $1 name commit $2, and ${file} names release $(release_field "$1" .release) at $(release_field "$1" .commit)"
}

# One release listing, verified against its recorded hash, cached per run.
release_sums() { # <repository> -> path
    local repository="$1" out url code
    out="${WORK}/SHA256SUMS-${repository}"
    if [ ! -f "${out}" ]; then
        url="$(release_field "${repository}" .url)SHA256SUMS"
        code="$(curl -sS -L -o "${out}" -w '%{http_code}' --max-time 120 "${url}" || echo 000)"
        [ "${code}" = 200 ] || die "downloading ${url} answered ${code} (000: not reached)"
        [ "$(sha256sum "${out}" | cut -d' ' -f1)" = "$(release_field "${repository}" .sha256sums)" ] ||
            die "${url} hashes to $(sha256sum "${out}" | cut -d' ' -f1), and ${RELEASES}/${repository}.json records $(release_field "${repository}" .sha256sums)"
    fi
    printf '%s\n' "${out}"
}

# The archive of one row into the cache, verified; prints its cached path.
obtain() { # <row fields...>
    local name="$1" version="$2" arch="$3" sha="$4" repository="$5" commit="$6" asset="$7" check="$8" pool="$9"
    local cached="${CACHE}/${sha}.deb" url code transport="" ref manifest title
    # A mica-system-base row is a layer of its pool manifest, which
    # tools/system-base.sh has already verified by digest.
    if [ "${repository}" != mica-system-base ]; then
        check_release "${repository}" "${commit}"
        transport="$(release_field "${repository}" .transport)"
    fi
    case "${transport}" in
    github-release)
        [ "$(awk -v a="${asset}" '$2 == a { print $1 }' "$(release_sums "${repository}")")" = "${sha}" ] ||
            die "${asset} is not listed at ${sha} in SHA256SUMS of ${repository} $(release_field "${repository}" .release)"
        url="$(release_field "${repository}" .url)${asset}"
        ;;
    oci)
        # The pool manifest names the archive by digest and by title; the release listing names it too.
        title="${name}_${version}_${arch}.deb"
        [ "$(awk -v t="${title}" '$2 == t { print $1 }' "$(release_sums "${repository}")")" = "${sha}" ] ||
            die "${title} is not listed at ${sha} in SHA256SUMS of ${repository} $(release_field "${repository}" .release)"
        ref="$(release_field "${repository}" ".pools.${pool}")"
        manifest="$(bash "${HERE}/oci.sh" manifest "${ref}")" || die "the ${pool} pool of ${repository} could not be read (see above)"
        jq -e --arg r "${repository}" --arg c "${commit}" --arg a "${pool}" --arg d "sha256:${sha}" --arg t "${title}" '
            .artifactType == "application/vnd.mica.pool" and .annotations["mica.source-repo"] == $r and .annotations["mica.source-commit"] == $c
            and .annotations["org.opencontainers.image.revision"] == $c and .annotations["mica.arch"] == $a
            and ([.layers[] | select(.digest == $d and .mediaType == "application/vnd.mica.deb" and .annotations["org.opencontainers.image.title"] == $t)] | length == 1)' "${manifest}" >/dev/null ||
            die "${ref} is not the ${pool} pool of ${repository} at ${commit} carrying ${title} as sha256:${sha}"
        ;;
    esac
    [ "${check}" = 0 ] || return 0
    if [ -f "${cached}" ] && [ "$(sha256sum "${cached}" | cut -d' ' -f1)" = "${sha}" ]; then
        printf '%s\n' "${cached}"
        return 0
    fi
    mkdir -p "${CACHE}"
    if [ "${repository}" = mica-system-base ]; then
        bash "${HERE}/system-base.sh" blob "${pool}" "${sha}" "${cached}.part" || { rm -f "${cached}.part"; die "reading ${asset} from the ${pool} pool of mica-system-base failed (see above)"; }
    elif [ "${transport}" = oci ]; then
        bash "${HERE}/oci.sh" blob "${ref%%[:@]*}" "${sha}" "${cached}.part" || { rm -f "${cached}.part"; die "reading ${title} from ${ref} failed (see above)"; }
    else
        code="$(curl -sS -L -o "${cached}.part" -w '%{http_code}' --max-time 1800 "${url}" || echo 000)"
        [ "${code}" = 200 ] || { rm -f "${cached}.part"; die "downloading ${url} answered ${code} (000: not reached)"; }
    fi
    [ "$(sha256sum "${cached}.part" | cut -d' ' -f1)" = "${sha}" ] || { rm -f "${cached}.part"; die "${asset} hashes to other bytes than the pinned ${sha}"; }
    mv "${cached}.part" "${cached}"
    printf '%s\n' "${cached}"
}

arch_arg() {
    case "${1:-}" in amd64 | arm64) ;; *) die "--arch must be amd64 or arm64" ;; esac
}

mkdir -p "${REPO_ROOT}/_out"
WORK="$(mktemp -d "${REPO_ROOT}/_out/.pool.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
cmd="${1:-}"; [ "$#" -eq 0 ] || shift
ARCH=""; PACKAGES=""; CHECK=0
while [ "$#" -gt 0 ]; do
    case "$1" in
    --arch) ARCH="${2:-}"; shift 2 ;;
    --packages) PACKAGES="${2:-}"; shift 2 ;;
    --check) CHECK=1; shift ;;
    *) die "unknown argument: $1" ;;
    esac
done

case "${cmd}" in
rows)
    [ -z "${ARCH}" ] || arch_arg "${ARCH}"
    rows "${ARCH}"
    ;;
fetch)
    arch_arg "${ARCH}"
    rows "${ARCH}" >"${WORK}/rows"
    if [ -n "${PACKAGES}" ]; then
        for p in ${PACKAGES}; do
            awk -F'\t' -v p="${p}" '$1 == p { found = 1 } END { exit !found }' "${WORK}/rows" || die "no ${ARCH} pin for ${p} under ${PINS}"
        done
        awk -F'\t' -v list=" ${PACKAGES} " 'index(list, " " $1 " ")' "${WORK}/rows" >"${WORK}/wanted"
    else
        cp "${WORK}/rows" "${WORK}/wanted"
    fi
    POOL="${POOL_ROOT}/${ARCH}/pool"
    : >"${WORK}/fetched"
    n=0
    while IFS=$'\t' read -r name version arch sha repository commit asset; do
        path="$(obtain "${name}" "${version}" "${arch}" "${sha}" "${repository}" "${commit}" "${asset}" "${CHECK}" "${ARCH}")"
        n=$((n + 1))
        [ "${CHECK}" = 1 ] || printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${path}" "${name}" "${version}" "${arch}" "${repository}" "${commit}" >>"${WORK}/fetched"
    done <"${WORK}/wanted"
    if [ "${CHECK}" = 1 ]; then
        echo "pool.sh: ${n} ${ARCH} archive(s) are published where their releases say, at their pinned digests"
        exit 0
    fi
    # The control fields, read by dpkg-deb in the build-env base image.
    image="$(bash "${HERE}/from.sh" --ref IMAGE_MICA_BUILD_BASE)"
    cut -f1 "${WORK}/fetched" | sed "s|^${CACHE}/||" >"${WORK}/names"
    docker run --rm --label ai-agent=true --network none -v "${CACHE}:/cache:ro" -v "${WORK}:/work" "${image}" \
        bash -c 'set -euo pipefail; while read -r f; do printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$f" "$(dpkg-deb -f "/cache/$f" Package)" "$(dpkg-deb -f "/cache/$f" Version)" "$(dpkg-deb -f "/cache/$f" Architecture)" "$(dpkg-deb -f "/cache/$f" Mica-Source-Repo)" "$(dpkg-deb -f "/cache/$f" Mica-Source-Commit)"; done </work/names' >"${WORK}/fields"
    mkdir -p "${POOL}"
    while IFS=$'\t' read -r path name version arch repository commit; do
        f="${path#"${CACHE}"/}"
        IFS=$'\t' read -r _ p v a r c < <(awk -F'\t' -v f="${f}" '$1 == f' "${WORK}/fields")
        [ "${p}" = "${name}" ] && [ "${v}" = "${version}" ] && [ "${a}" = "${arch}" ] ||
            die "${f} says Package ${p:-?}, Version ${v:-?}, Architecture ${a:-?}; the pin says ${name} ${version} ${arch}"
        { [ -z "${r}" ] && [ -z "${c}" ]; } || { [ "${r}" = "${repository}" ] && [ "${c}" = "${commit}" ]; } ||
            die "${name} ${version} says Mica-Source-Repo ${r}, Mica-Source-Commit ${c}; the pin says ${repository} ${commit}"
        for other in "${POOL}/${name}"_*_*.deb; do
            [ -e "${other}" ] && [ "${other##*/}" != "${name}_${version}_${arch}.deb" ] && rm -f "${other}"
        done
        cp "${path}" "${POOL}/${name}_${version}_${arch}.deb"
    done <"${WORK}/fetched"
    echo "pool.sh: ${n} ${ARCH} archive(s) verified into ${POOL#"${REPO_ROOT}"/}"
    ;;
index)
    arch_arg "${ARCH}"
    DIST="${POOL_ROOT}/${ARCH}"
    [ -n "$(find "${DIST}/pool" -maxdepth 1 -name '*.deb' 2>/dev/null)" ] || die "${DIST}/pool holds no archive; fetch first"
    rows "${ARCH}" >"${WORK}/rows"
    image="$(bash "${HERE}/from.sh" --ref IMAGE_MICA_BUILD_BASE)"
    # mica-build-side: container-block -- dpkg-scanpackages and dpkg-deb run in IMAGE_MICA_BUILD_BASE.
    docker run --rm --label ai-agent=true --network none -v "${DIST}:/dist" -v "${WORK}:/work:ro" -w /dist -e "ARCH=${ARCH}" "${image}" bash -c '
        set -euo pipefail
        mapfile -t debs < <(cd pool && find . -maxdepth 1 -type f -name "*.deb" -printf "%f\n" | LC_ALL=C sort)
        dpkg-scanpackages --multiversion pool >Packages 2>/dev/null
        [ -s Packages ] || { echo "pool.sh: error: empty Packages" >&2; exit 1; }
        (printf "pool/%s\n" "${debs[@]}" | xargs -r sha256sum) >SHA256SUMS
        {
            echo "# The imported package pool for ${ARCH}, read out of the archives by tools/pool.sh index."
            printf "#package\tversion\tarchitecture\tinstalled-size\tsha256\tfile\tsource-repo\tsource-commit\n"
            for d in "${debs[@]}"; do
                p="$(dpkg-deb -f "pool/$d" Package)"; a="$(dpkg-deb -f "pool/$d" Architecture)"
                pin="$(awk -F"\t" -v p="$p" -v a="$a" "\$1 == p && \$3 == a" /work/rows)"
                [ -n "$pin" ] || { echo "pool.sh: error: pool/$d is not pinned" >&2; exit 1; }
                printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$p" "$(dpkg-deb -f "pool/$d" Version)" "$a" "$(dpkg-deb -f "pool/$d" Installed-Size)" \
                    "$(sha256sum "pool/$d" | cut -d" " -f1)" "pool/$d" "$(printf "%s" "$pin" | cut -f5)" "$(printf "%s" "$pin" | cut -f6)"
            done
        } >manifest.txt'
    # mica-build-side: host
    echo "pool.sh: ${DIST#"${REPO_ROOT}"/} indexed"
    ;;
*)
    die "usage: bash tools/pool.sh rows [--arch A] | fetch --arch A [--packages \"...\"] [--check] | index --arch A"
    ;;
esac
