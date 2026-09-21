#!/usr/bin/env bash
# The package pool: the package rows of locks/ and this tree's own built archives, fetch and index.
#
#   bash tools/pool.sh rows [--arch <amd64|arch64>]
#       every pinned archive as a row: package, version, architecture, sha256, repository, commit, file;
#       and every archive of this tree's own producers (tools/deb/producers.sh: the board and radio
#       packages, built by make board-pool) that is in _out/debs/<arch>/pool at its declared version,
#       as a row of repository mica-build at the tree's HEAD commit, its sha256 the archive's
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
#           application/vnd.mica.pool of that repository and architecture; it carries no
#           release or commit, so one pool digest may be tagged by several releases.
#           The commit column is the lock's release row; an archive carries none.
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

# One row per archive of this tree's own producers that is built into the wanted pools, at its declared
# version (producers.sh --version-for); an `all` archive is a row of every pool that holds it.
own_rows() { # [arch]
    local want="${1:-}" producer dir arches packages enablement version arch deb_arch a deb
    bash "${HERE}/deb/producers.sh" | while read -r producer dir arches packages enablement; do
        read -r version _ < <(bash "${HERE}/deb/producers.sh" --version-for "${producer}") || die "no declared version of the producer ${producer}"
        deb_arch=""; case ",${arches}," in *",all,"*) deb_arch=all ;; esac
        for a in amd64 arm64; do
            [ -z "${want}" ] || [ "${a}" = "${want}" ] || continue
            arch="${deb_arch:-${a}}"
            [ "${arch}" = all ] || [[ ",${arches}," == *",${a},"* ]] || continue
            for p in ${packages//,/ }; do
                deb="${POOL_ROOT}/${a}/pool/${p}_${version}_${arch}.deb"
                [ -f "${deb}" ] || continue
                printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${p}" "${version}" "${arch}" "$(sha256sum "${deb}" | cut -d' ' -f1)" mica-build "${OWN_COMMIT}" "${deb##*/}"
            done
        done
    done
    own_rows "${want}"
}
OWN_COMMIT="$(git -C "${REPO_ROOT}" rev-parse HEAD 2>/dev/null || printf '0%.0s' $(seq 40))"

# One row per package row of the wanted pools, joined with its pool manifest, then the tree's own.
rows() { # [arch]
    local want="${1:-}" input repository arch ref commit manifest
    python3 "${HERE}/locks.py" rows release >"${WORK}/release" || die "locks/ could not be read (see above)"
    python3 "${HERE}/locks.py" rows package >"${WORK}/package"
    python3 "${HERE}/locks.py" rows pool >"${WORK}/pools"
    { while IFS=$'\t' read -r input arch ref; do
        [ -z "${want}" ] || [ "${arch}" = "${want}" ] || continue
        # An input is <repository>[.<scope>]; the pool and its archives name the repository.
        repository="${input%%.*}"
        commit="$(awk -F'\t' -v i="${input}" '$1 == i { print $4 }' "${WORK}/release")"
        manifest="$(bash "${HERE}/oci.sh" manifest "${ref}")" || die "the ${arch} pool of ${repository} could not be read (see above)"
        awk -F'\t' -v i="${input}" -v a="${arch}" '$1 == i && $3 == a { print $2 "\t" $4 "\t" $5 }' "${WORK}/package" |
            jq -rR --slurpfile m "${manifest}" --arg r "${repository}" --arg c "${commit}" --arg a "${arch}" --arg ref "${ref}" --arg i "${input}" '
            $m[0] as $m
            | if ($m.artifactType == "application/vnd.mica.pool" and $m.annotations["mica.source-repo"] == $r and $m.annotations["mica.arch"] == $a) then . else
                error("\($ref) is not the \($a) pool of \($r)") end
            | split("\t") as [$n, $v, $s]
            | [$m.layers[] | select(.digest == "sha256:" + $s and .mediaType == "application/vnd.mica.deb")] as $l
            | if ($l | length) != 1 then error("the \($a) pool of \($r) carries no archive layer sha256:\($s) for \($n) \($v)") else . end
            | $l[0].annotations["org.opencontainers.image.title"] as $t
            | if ($t == $n + "_" + $v + "_" + $a + ".deb" or $t == $n + "_" + $v + "_all.deb") then . else
                error("layer sha256:\($s) of the \($a) pool of \($r) is titled \($t), not \($n)_\($v)_\($a).deb or _all.deb") end
            | [$n, $v, ($t | rtrimstr(".deb") | split("_") | last), $s, $r, $c, $t, $i] | @tsv' ||
            die "the ${arch} pool of ${repository} does not carry its package rows (see above)"
    done <"${WORK}/pools"
    # ONE PACKAGE IS ONE ROW, AND THE KEY IS ITS IDENTITY. A package's identity is its name, its architecture
    # and its digest; the input that pins it and that input's release commit are PROVENANCE, not identity. Two
    # inputs pinning the same bytes is legitimate and permanent: a board release is self-contained, so every
    # board that ships a radio publishes the shared `Architecture: all` archives itself, and mica-bluetooth,
    # mica-wifi and mica-wifi-ap are each pinned by two board locks at the same name, version and sha256. Those
    # rows collapse to one. The bytes are identical by construction rather than by luck -- the radio producers
    # take no board argument anywhere in their build path -- and this tree is the only place that ever sees two
    # board pools at once, which is why the check lives here.
    #
    # Two inputs pinning the same name and architecture at DIFFERENT digests is what this guard exists to catch.
    # It means one package NAME is covering two different archives, which is a naming defect rather than a
    # duplication, and the escape is a name of its own with its own producer: a board that needs a radio archive
    # the shared one cannot be publishes it under its own package name. The refusal says so, and names both
    # digests and both inputs.
    #
    # The collapsed row keeps the provenance of the input whose name sorts first (mica-boards.cx3576 before
    # mica-boards.s905x5m). Either input is defensible because the bytes are the same; what matters is that the
    # choice is deterministic, so two readers of one tree produce the same rows.
    #
    # The eighth field is the input, carried for those messages and for that choice, and dropped from the output:
    # the row this prints is the seven fields every reader of `pool.sh rows` already reads.
    } | LC_ALL=C sort -u | awk -F'\t' '
        { key = $1 "\t" $3
          row = $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 "\t" $6 "\t" $7
          if (!(key in seen)) { seen[key] = 1; order[++n] = key; digest[key] = $4; input[key] = $8; line[key] = row; next }
          if (digest[key] != $4) {
              printf "pool.sh: error: %s is pinned twice for %s at two digests: sha256:%s by %s and sha256:%s by %s.\n",
                  $1, $3, digest[key], input[key], $4, $8 > "/dev/stderr"
              printf "       One package name covers two archives, which is a naming defect, not a duplication: give the one that\n" > "/dev/stderr"
              printf "       differs its own name and its own producer, as a board publishes its own radio package beside the shared one.\n" > "/dev/stderr"
              exit 1
          }
          if ($8 < input[key]) { input[key] = $8; line[key] = row } }
        END { for (j = 1; j <= n; j++) print line[order[j]] }'
}

# The archive of one row into the cache, verified; prints its cached path.
obtain() { # <sha256> <repository> <pool arch> <file>
    local sha="$1" repository="$2" pool="$3" file="$4" cached="${CACHE}/$1.deb" ref
    if [ -f "${cached}" ] && [ "$(sha256sum "${cached}" | cut -d' ' -f1)" = "${sha}" ]; then
        printf '%s\n' "${cached}"
        return 0
    fi
    # Every pool of the repository lives in its one registry repository (ghcr.io/micaoss/<repository> or local/<repository>).
    ref="$(python3 "${HERE}/locks.py" rows pool | awk -F'\t' -v r="${repository}" -v a="${pool}" '($1 == r || index($1, r ".") == 1) && $2 == a { print $3; exit }')"
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
        bash -c 'set -euo pipefail; while read -r f; do printf "%s\t%s\t%s\t%s\t%s\n" "$f" "$(dpkg-deb -f "/cache/$f" Package)" "$(dpkg-deb -f "/cache/$f" Version)" "$(dpkg-deb -f "/cache/$f" Architecture)" "$(dpkg-deb -f "/cache/$f" Mica-Source-Repo)"; done </work/names' >"${WORK}/fields"
    mkdir -p "${POOL}"
    while IFS=$'\t' read -r path name version arch repository commit; do
        f="${path#"${CACHE}"/}"
        IFS=$'\t' read -r _ p v a r < <(awk -F'\t' -v f="${f}" '$1 == f' "${WORK}/fields")
        [ "${p}" = "${name}" ] && [ "${v}" = "${version}" ] && [ "${a}" = "${arch}" ] ||
            die "${f} says Package ${p:-?}, Version ${v:-?}, Architecture ${a:-?}; locks/ says ${name} ${version} ${arch}"
        [ -z "${r}" ] || [ "${r}" = "${repository}" ] ||
            die "${name} ${version} says Mica-Source-Repo ${r}; locks/ says ${repository}"
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
