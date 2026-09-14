#!/usr/bin/env bash
# The GitHub Release assets of a mica-build release.
#
#   bash tools/release-assets.sh collect <product> <YYYYMMDD-HHMM> <dir>
#       the built product (tools/product-build.sh <product> --release <tag>) as release assets in <dir>:
#         mica-<product>-<tag>.img              the factory image
#         mica-<product>-<tag>.micaupd           the signed update archive of generation 2
#         mica-<product>-<tag>-components.tar   kernel/, root/, firmware/, deployments/ and records.json
#         mica-<product>-<tag>-release.tar      the gated release directory: manifest.json (channel
#                                               development), SHA256SUMS and the records it measures
#   bash tools/release-assets.sh sums <dir>
#       SHA256SUMS over every asset in <dir>
#
# The tar is written with sorted names, numeric root ownership and the pinned
# epoch, so the same components give the same bytes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
die() { echo "release-assets.sh: error: $*" >&2; exit 1; }

case "${1:-}" in
collect)
    [ "$#" -eq 4 ] || die "usage: collect <product> <YYYYMMDD-HHMM> <dir>"
    product="$2"; tag="$3"; dir="$4"
    [[ "${tag}" =~ ^[0-9]{8}-[0-9]{4}$ ]] || die "the release name must be YYYYMMDD-HHMM"
    out="${REPO_ROOT}/_out/products/${product}"
    grep -qx "release ${tag}" "${out}/receipt.txt" 2>/dev/null || die "${out} is not a build of release ${tag} (tools/product-build.sh ${product} --release ${tag})"
    image="$(awk 'NR == 1 { print $2 }' "${out}/image/SHA256SUMS")"
    [ -n "${image}" ] && [ -f "${out}/image/${image}" ] || die "${out}/image holds no image"
    (cd "${out}/image" && sha256sum --quiet -c SHA256SUMS) || die "${out}/image does not match its SHA256SUMS"
    [ -f "${out}/update.micaupd" ] || die "${out} holds no update archive"
    [ "$(jq -r .channel "${out}/release/manifest.json" 2>/dev/null)" = development ] ||
        die "${out}/release is not a release directory of the development channel (tools/product-build.sh ${product} --release ${tag})"
    mkdir -p "${dir}"
    cp "${out}/image/${image}" "${dir}/mica-${product}-${tag}.img"
    cp "${out}/update.micaupd" "${dir}/mica-${product}-${tag}.micaupd"
    tar -C "${out}" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@1577836800 \
        -cf "${dir}/mica-${product}-${tag}-components.tar" kernel root firmware deployments records.json
    tar -C "${out}" --sort=name --owner=0 --group=0 --numeric-owner --mtime=@1577836800 \
        -cf "${dir}/mica-${product}-${tag}-release.tar" release
    echo "release-assets.sh: ${product} ${tag} collected into ${dir}"
    ;;
sums)
    [ "$#" -eq 2 ] || die "usage: sums <dir>"
    dir="$2"
    [ -n "$(find "${dir}" -maxdepth 1 -type f -name 'mica-*' -print -quit)" ] || die "${dir} holds no asset"
    (cd "${dir}" && find . -maxdepth 1 -type f -name 'mica-*' -printf '%f\n' | LC_ALL=C sort | xargs sha256sum >SHA256SUMS)
    cat "${dir}/SHA256SUMS"
    ;;
*)
    die "usage: bash tools/release-assets.sh collect <product> <YYYYMMDD-HHMM> <dir> | sums <dir>"
    ;;
esac
