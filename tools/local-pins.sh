#!/usr/bin/env bash
# Pins for a local build: a sibling checkout's own pools stand in for its release.
#
#   bash tools/local-pins.sh <repository> <checkout>
#
#   reads   <checkout>/_out/debs/<amd64|arm64>/pool/*.deb   (the repository's own build)
#   writes  deps/packages/<package>.json for every archive whose Mica-Source-Repo is <repository>,
#           deps/releases/<repository>.json                  (transport local)
#
# THIS IS NEVER A RELEASE INPUT. tools/pool.sh and tools/source.sh refuse a
# local record under GitHub Actions, and product-build.sh --release refuses one.
# The composer binds a root to a clean commit, so a local build commits the pins
# on a local branch of its own, which is never pushed.
#
# The pins are replaced whole, as a release is: every pin of <repository>, and
# every pin of a package the checkout now builds (a package that moved there
# from another repository), is removed before the checkout's archives are
# pinned. All archives must come from one commit, the checkout's HEAD.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
die() { echo "local-pins.sh: error: $*" >&2; exit 1; }

REPOSITORY="${1:-}"; CHECKOUT="${2:-}"
[[ "${REPOSITORY}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] && [ -n "${CHECKOUT}" ] || die "usage: bash tools/local-pins.sh <repository> <checkout>"
CHECKOUT="$(cd "${CHECKOUT}" && pwd)" || die "${2} is not a directory"
[ "${CHECKOUT}" != "${REPO_ROOT}" ] || die "the checkout is this tree"
COMMIT="$(git -C "${CHECKOUT}" rev-parse HEAD)" || die "${CHECKOUT} is not a git checkout"

WORK="$(mktemp -d "${REPO_ROOT}/_out/.local-pins.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
: >"${WORK}/fields"
image="$(bash "${HERE}/from.sh" --ref IMAGE_MICA_BUILD_BASE)"
for pool in amd64 arm64; do
    [ -d "${CHECKOUT}/_out/debs/${pool}/pool" ] || continue
    # The pool as its build indexed it: exactly the archives its SHA256SUMS lists, at those digests.
    [ -f "${CHECKOUT}/_out/debs/${pool}/SHA256SUMS" ] || die "${CHECKOUT}/_out/debs/${pool} has no SHA256SUMS; index the pool in ${CHECKOUT} first"
    (cd "${CHECKOUT}/_out/debs/${pool}" && sha256sum --quiet -c SHA256SUMS) || die "${CHECKOUT}/_out/debs/${pool}/pool does not match its SHA256SUMS"
    [ "$(sed 's/^[0-9a-f]\{64\}  //' "${CHECKOUT}/_out/debs/${pool}/SHA256SUMS" | LC_ALL=C sort)" = "$(cd "${CHECKOUT}/_out/debs/${pool}" && find pool -maxdepth 1 -name '*.deb' | LC_ALL=C sort)" ] ||
        die "${CHECKOUT}/_out/debs/${pool}/pool holds other archives than its SHA256SUMS lists"
    # mica-build-side: container-block -- dpkg-deb runs in IMAGE_MICA_BUILD_BASE.
    docker run --rm --label ai-agent=true --network none -v "${CHECKOUT}/_out/debs/${pool}/pool:/pool:ro" -e "POOL=${pool}" "${image}" \
        bash -c 'set -euo pipefail; cd /pool; for f in *.deb; do [ -e "$f" ] || continue; printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\n" "$POOL" "$f" "$(dpkg-deb -f "$f" Package)" "$(dpkg-deb -f "$f" Version)" "$(dpkg-deb -f "$f" Architecture)" "$(dpkg-deb -f "$f" Mica-Source-Repo)" "$(dpkg-deb -f "$f" Mica-Source-Commit)"; done' >>"${WORK}/fields"
    # mica-build-side: host
done
awk -F'\t' -v r="${REPOSITORY}" '$6 == r' "${WORK}/fields" >"${WORK}/own"
[ -s "${WORK}/own" ] || die "${CHECKOUT}/_out/debs holds no archive whose Mica-Source-Repo is ${REPOSITORY}"
while IFS=$'\t' read -r pool file name version arch _ commit; do
    [ "${commit}" = "${COMMIT}" ] || die "${pool}/pool/${file} was built from ${commit:-no commit}, and ${CHECKOUT} is at ${COMMIT}"
    [ "${file}" = "${name}_${version}_${arch}.deb" ] || die "${pool}/pool/${file} is not named ${name}_${version}_${arch}.deb"
done <"${WORK}/own"

for f in "${REPO_ROOT}"/deps/packages/*.json; do
    name="$(basename "${f}" .json)"
    if [ "$(jq -r .repository "${f}")" = "${REPOSITORY}" ] || cut -f3 "${WORK}/own" | grep -Fx -- "${name}" >/dev/null; then
        rm -f "${f}"
    fi
done
n=0
while IFS= read -r name; do
    awk -F'\t' -v n="${name}" '$3 == n' "${WORK}/own" | while IFS=$'\t' read -r pool file _ version arch _ _; do
        jq -n --arg p "${pool}" --arg v "${version}" --arg a "${arch}" --arg s "$(sha256sum "${CHECKOUT}/_out/debs/${pool}/pool/${file}" | cut -d' ' -f1)" --arg f "${file}" \
            '{($p): {version: $v, architecture: $a, sha256: $s, asset: ($f | gsub("\\+"; "."))}}'
    done | jq -s --arg n "${name}" --arg r "${REPOSITORY}" --arg c "${COMMIT}" '{name: $n, repository: $r, commit: $c, targets: add}' >"${REPO_ROOT}/deps/packages/${name}.json"
    n=$((n + 1))
done < <(cut -f3 "${WORK}/own" | LC_ALL=C sort -u)
jq -n --arg r "${REPOSITORY}" --arg c "${COMMIT}" --arg d "${CHECKOUT}" '{repository: $r, commit: $c, transport: "local", checkout: $d}' >"${REPO_ROOT}/deps/releases/${REPOSITORY}.json"
bash "${HERE}/pool.sh" rows >/dev/null
echo "local-pins.sh: ${n} package(s) of ${REPOSITORY} pinned at ${COMMIT} from ${CHECKOUT}/_out/debs (local only; never a release input)"
