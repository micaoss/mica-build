#!/usr/bin/env bash
# The imported package pool: the package rows of locks/, fetch and index.
#
#   bash tools/pool.sh rows [--arch <amd64|arm64>]
#       every pinned archive as a row: package, version, architecture, sha256, repository, commit, file
#   bash tools/pool.sh fetch --arch <amd64|arm64> [--packages "<p> ..."] [--check]
#       download and verify the pinned archives into _out/debs/<arch>/pool
#       (--check reads the pool manifests only)
#   bash tools/pool.sh index --arch <amd64|arm64>
#       Packages, SHA256SUMS and manifest.txt over _out/debs/<arch>/pool
#
#   reads   locks/<repository>.lock (tools/locks.py, which checks every lock and pin first): the
#           release row (the commit), the pool row of each architecture and the package rows.
#           A package is the layer of its pool manifest whose digest is the row's sha256; the
#           layer's title, <package>_<version>_<architecture>.deb, gives the archive's
#           architecture (the pool's or all) and must name the row's package and version.
#           The manifest is read by digest (tools/oci.sh) and must be the
#           application/vnd.mica.pool of that repository, commit and architecture.
#   writes  _out/debs/<arch>/pool/*.deb, _out/debs/<arch>/{Packages,SHA256SUMS,manifest.txt},
#           _out/cache/pool/<sha256>.deb (the download cache; a cached archive is hashed again)
#
# A reader reads only the location its lock names: a refused token, 404,
# transport failure, wrong identity or hash mismatch stops it, with no
# fallback. Every archive is also read for its control fields, which must equal
# the row. MICA_POOL_DIR overrides _out/debs.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
POOL_ROOT="${MICA_POOL_DIR:-${REPO_ROOT}/_out/debs}"
CACHE="${MICA_POOL_CACHE:-${REPO_ROOT}/_out/cache/pool}"

die() { echo "pool.sh: error: $*" >&2; exit 1; }
for t in curl jq sha256sum python3; do
    command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"
done

# One row per package row of the wanted pools, joined with its pool manifest.
rows() { # [arch]
    local want="${1:-}" repository arch ref commit manifest
    python3 "${HERE}/locks.py" rows release >"${WORK}/release" || die "locks/ could not be read (see above)"
    python3 "${HERE}/locks.py" rows package >"${WORK}/package"
    python3 "${HERE}/locks.py" rows pool >"${WORK}/pools"
    { while IFS=$'\t' read -r repository arch ref; do
        [ -z "${want}" ] || [ "${arch}" = "${want}" ] || continue
        commit="$(awk -F'\t' -v r="${repository}" '$1 == r { print $4 }' "${WORK}/release")"
        manifest="$(bash "${HERE}/oci.sh" manifest "${ref}")" || die "the ${arch} pool of ${repository} could not be read (see above)"
        awk -F'\t' -v r="${repository}" -v a="${arch}" '$1 == r && $3 == a { print $2 "\t" $4 "\t" $5 }' "${WORK}/package" |
            jq -rR --slurpfile m "${manifest}" --arg r "${repository}" --arg c "${commit}" --arg a "${arch}" --arg ref "${ref}" '
            $m[0] as $m
            | if ($m.artifactType == "application/vnd.mica.pool" and $m.annotations["mica.source-repo"] == $r and $m.annotations["mica.source-commit"] == $c
                  and $m.annotations["org.opencontainers.image.revision"] == $c and $m.annotations["mica.arch"] == $a) then . else
                error("\($ref) is not the \($a) pool of \($r) at \($c)") end
            | split("\t") as [$n, $v, $s]
            | [$m.layers[] | select(.digest == "sha256:" + $s and .mediaType == "application/vnd.mica.deb")] as $l
            | if ($l | length) != 1 then error("the \($a) pool of \($r) carries no archive layer sha256:\($s) for \($n) \($v)") else . end
            | $l[0].annotations["org.opencontainers.image.title"] as $t
            | if ($t == $n + "_" + $v + "_" + $a + ".deb" or $t == $n + "_" + $v + "_all.deb") then . else
                error("layer sha256:\($s) of the \($a) pool of \($r) is titled \($t), not \($n)_\($v)_\($a).deb or _all.deb") end
            | [$n, $v, ($t | rtrimstr(".deb") | split("_") | last), $s, $r, $c, $t] | @tsv' ||
            die "the ${arch} pool of ${repository} does not carry its package rows (see above)"
    done <"${WORK}/pools"
    } | LC_ALL=C sort -u | awk -F'\t' '
        { key = $1 "\t" $3; if (key in seen) { printf "pool.sh: error: %s is pinned twice for %s\n", $1, $3 > "/dev/stderr"; exit 1 }
          seen[key] = 1; print }'
}

# The archive of one row into the cache, verified; prints its cached path.
obtain() { # <sha256> <repository> <pool arch> <file>
    local sha="$1" repository="$2" pool="$3" file="$4" cached="${CACHE}/$1.deb" ref
    if [ -f "${cached}" ] && [ "$(sha256sum "${cached}" | cut -d' ' -f1)" = "${sha}" ]; then
        printf '%s\n' "${cached}"
        return 0
    fi
    ref="$(python3 "${HERE}/locks.py" rows pool "${repository}" | awk -F'\t' -v a="${pool}" '$2 == a { print $3 }')"
    mkdir -p "${CACHE}"
    bash "${HERE}/oci.sh" blob "${ref%%[:@]*}" "${sha}" "${cached}.part" || { rm -f "${cached}.part"; die "reading ${file} from ${ref} failed (see above)"; }
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
            awk -F'\t' -v p="${p}" '$1 == p { found = 1 } END { exit !found }' "${WORK}/rows" || die "no ${ARCH} package row for ${p} in locks/"
        done
        awk -F'\t' -v list=" ${PACKAGES} " 'index(list, " " $1 " ")' "${WORK}/rows" >"${WORK}/wanted"
    else
        cp "${WORK}/rows" "${WORK}/wanted"
    fi
    n="$(grep -c . "${WORK}/wanted" || true)"
    if [ "${CHECK}" = 1 ]; then
        echo "pool.sh: ${n} ${ARCH} archive(s) are layers of their pinned pool manifests"
        exit 0
    fi
    POOL="${POOL_ROOT}/${ARCH}/pool"
    : >"${WORK}/fetched"
    while IFS=$'\t' read -r name version arch sha repository commit file; do
        path="$(obtain "${sha}" "${repository}" "${ARCH}" "${file}")"
        printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${path}" "${name}" "${version}" "${arch}" "${repository}" "${commit}" >>"${WORK}/fetched"
    done <"${WORK}/wanted"
    # The control fields, read by dpkg-deb in the build-env base image.
    image="$(bash "${HERE}/from.sh" --ref mica-build-env:base)"
    cut -f1 "${WORK}/fetched" | sed "s|^${CACHE}/||" >"${WORK}/names"
    docker run --rm --label ai-agent=true --network none -v "${CACHE}:/cache:ro" -v "${WORK}:/work" "${image}" \
        bash -c 'set -euo pipefail; while read -r f; do printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$f" "$(dpkg-deb -f "/cache/$f" Package)" "$(dpkg-deb -f "/cache/$f" Version)" "$(dpkg-deb -f "/cache/$f" Architecture)" "$(dpkg-deb -f "/cache/$f" Mica-Source-Repo)" "$(dpkg-deb -f "/cache/$f" Mica-Source-Commit)"; done </work/names' >"${WORK}/fields"
    mkdir -p "${POOL}"
    while IFS=$'\t' read -r path name version arch repository commit; do
        f="${path#"${CACHE}"/}"
        IFS=$'\t' read -r _ p v a r c < <(awk -F'\t' -v f="${f}" '$1 == f' "${WORK}/fields")
        [ "${p}" = "${name}" ] && [ "${v}" = "${version}" ] && [ "${a}" = "${arch}" ] ||
            die "${f} says Package ${p:-?}, Version ${v:-?}, Architecture ${a:-?}; locks/ says ${name} ${version} ${arch}"
        { [ -z "${r}" ] && [ -z "${c}" ]; } || { [ "${r}" = "${repository}" ] && [ "${c}" = "${commit}" ]; } ||
            die "${name} ${version} says Mica-Source-Repo ${r}, Mica-Source-Commit ${c}; locks/ says ${repository} ${commit}"
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
    image="$(bash "${HERE}/from.sh" --ref mica-build-env:base)"
    # mica-build-side: container-block -- dpkg-scanpackages and dpkg-deb run in mica-build-env:base.
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
                [ -n "$pin" ] || { echo "pool.sh: error: pool/$d is not a package row of locks/" >&2; exit 1; }
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
