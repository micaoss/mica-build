#!/usr/bin/env bash
# A scoped mica-build release (mica:docs/decisions/2026-09-15-mica-build-scoped-releases.md,
# mica:docs/design/release-lock.md 1.2.2): <scope>/<YYYYMMDD-HHMM>, a board (all its products) or one product.
#
#   bash tools/release.sh plan <scope>/<YYYYMMDD-HHMM>
#       one line per product of the scope: product, board, generation, previous release (or -),
#       its kernel id and rootfs id (or -); the generation is one above the previous release's
#       product row, 2 for a product's first release
#   bash tools/release.sh collect <product> <scope>/<YYYYMMDD-HHMM> <plan> <dir>
#       the built product (tools/product-build.sh <product> --release <YYYYMMDD-HHMM> --generation <g>)
#       into <dir>: its image and update files under <dir>/assets and its rows under <dir>/rows
#   bash tools/release.sh publish <scope>/<YYYYMMDD-HHMM> <dir>
#       per product the OCI bundles image.<product>.<release> and update.<product>.<release>, read back
#       anonymously; then <dir>/mica-build.lock and <dir>/SHA256SUMS listing only it
#   bash tools/release.sh attach <scope>/<YYYYMMDD-HHMM> <dir>
#       the assets, then the lock and SHA256SUMS last, to the GitHub Release, read back anonymously
#
# WHICH UPDATE PACKAGES. full always. root only when the previous release's kernel id equals this
# one's, kernel only when its rootfs id does: a partial package installs on a device only when the
# component it omits is already there. A verity key rotation re-signs the root, so it moves the
# rootfs id and ships as full.
#
# IMAGES ARE PUBLISHED GZIP-COMPRESSED. An image kind's asset and layer is <file>.gz, gzip -n -9 in the
# pinned build-env base image: compressed twice to the same bytes, and decompressed to the sha256 and size
# of the raw signed image the product built, gated and verified, which the layer records as
# mica.uncompressed-sha256 and mica.uncompressed-size (with mica.compression=gzip).
#
# THE REPRODUCIBILITY GUARD. A kernel component whose buildId, the hash of everything it is packed from,
# equals the previous release's while its id differs is refused: the same inputs packed to other bytes.
# The previous buildId is read out of the signed descriptor at the head of that release's full update
# archive (a range read), authenticated with the updates key, and tied to its product row by kernel id.
#
#   reads   products/, locks/ and locks/pins/, _out/products/<product>/ (a release build; MICA_RELEASE_PRODUCTS), meta or
#           MICA_SIGNING_OUTPUT (the updates public key); previous releases from the GitHub Releases of
#           micaoss/mica-build, or MICA_RELEASE_HISTORY=<dir> of <scope>_<YYYYMMDD-HHMM>/{mica-build.lock,SHA256SUMS}
#   env     MICA_REGISTRY (tools/registry.sh), GH_TOKEN for attach
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
cd "${REPO_ROOT}"
# shellcheck source=tools/registry.sh
. "${HERE}/registry.sh"
die() { echo "release.sh: error: $*" >&2; exit 1; }
for t in curl jq sha256sum python3; do command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"; done
export LC_ALL=C
MAX_ASSET=$((2 * 1024 * 1024 * 1024))

tag_parts() { # <tag> -> SCOPE, RELEASE
    [[ "$1" =~ ^([a-z0-9][a-z0-9-]*)/([0-9]{8}-[0-9]{4})$ ]] || die "the release tag must be <scope>/<YYYYMMDD-HHMM>, not '$1'"
    SCOPE="${BASH_REMATCH[1]}"; RELEASE="${BASH_REMATCH[2]}"
}

# The released products of the scope, one per line: a product's own name, or every product of a board;
# a product declaring PUBLISH=0 (products/README.md) is never part of a release.
scope_products() {
    local p board found="" released=""
    for p in $(bash tools/product.sh --list); do
        board="$(sed -n 's/^BOARD=//p' "products/${p}/product.env" | tr -d '"')"
        [ "${p}" = "${SCOPE}" ] || [ "${board}" = "${SCOPE}" ] || continue
        found=1
        [ "$(sed -n 's/^PUBLISH=//p' "products/${p}/product.env" | tr -d '"')" != 0 ] || continue
        printf '%s\t%s\n' "${p}" "${board}"; released=1
    done
    [ -n "${found}" ] || die "the scope ${SCOPE} is neither a product nor the board of a product"
    [ -n "${released}" ] || die "the scope ${SCOPE} holds only products that are never released (PUBLISH=0)"
}

# Every earlier release's lock, newest first: <release label> TAB <lock path>. Each lock is the one its
# SHA256SUMS lists, and a valid lock. The release being built and a release with no asset at all (one
# whose run failed before attaching, since the lock is attached last) are not earlier releases; a
# release with assets and without both of these is refused, never skipped.
history() { # <work>
    local work="$1" label dir n=0
    mkdir -p "${work}/downloads"
    if [ -n "${MICA_RELEASE_HISTORY:-}" ]; then
        for dir in "${MICA_RELEASE_HISTORY}"/*_*; do
            [ -d "${dir}" ] || continue
            label="$(basename "${dir}")"; label="${label%%_*}/${label#*_}"
            [ "${label}" != "${SCOPE}/${RELEASE}" ] && [ -n "$(ls -A "${dir}")" ] || continue
            printf '%s\t%s\t%s\n' "${label}" "${dir}/mica-build.lock" "${dir}/SHA256SUMS"
        done >"${work}/history.list"
    else
        local auth=() page=1
        [ -z "${GH_TOKEN:-}" ] || auth=(-H "Authorization: Bearer ${GH_TOKEN}")
        : >"${work}/releases.json"
        while :; do
            curl -fsS --max-time 60 "${auth[@]}" "https://api.github.com/repos/micaoss/mica-build/releases?per_page=100&page=${page}" >"${work}/page.json" ||
                die "the GitHub Releases of micaoss/mica-build could not be listed"
            [ "$(jq length "${work}/page.json")" -gt 0 ] || break
            jq -c '.[]' "${work}/page.json" >>"${work}/releases.json"
            page=$((page + 1))
        done
        : >"${work}/history.list"
        while IFS= read -r label; do
            n=$((n + 1)); dir="${work}/downloads/${n}"; mkdir -p "${dir}"
            for asset in mica-build.lock SHA256SUMS; do
                curl -fsSL --max-time 120 -o "${dir}/${asset}" "https://github.com/micaoss/mica-build/releases/download/${label}/${asset}" ||
                    die "release ${label} of micaoss/mica-build has no readable ${asset}; an earlier release without its lock is refused"
            done
            printf '%s\t%s\t%s\n' "${label}" "${dir}/mica-build.lock" "${dir}/SHA256SUMS" >>"${work}/history.list"
        done < <(jq -r --arg self "${SCOPE}/${RELEASE}" 'select((.draft | not) and .tag_name != $self and (.assets | length) > 0) | .tag_name' "${work}/releases.json" |
            grep -E '^[a-z0-9][a-z0-9-]*/[0-9]{8}-[0-9]{4}$' || true)
    fi
    while IFS=$'\t' read -r label lock sums; do
        [ "$(cat "${sums}" 2>/dev/null)" = "$(sha256sum "${lock}" 2>/dev/null | cut -d' ' -f1)  mica-build.lock" ] ||
            die "release ${label}: SHA256SUMS does not list exactly its mica-build.lock"
        python3 tools/locks.py lock "${lock}" >/dev/null || die "release ${label}: its mica-build.lock breaks a rule (see above)"
        [ "$(awk -F'\t' '$1 == "release" { print $3 }' "${lock}")" = "${label}" ] || die "release ${label}: its lock names another release"
        printf '%s\t%s\t%s\n' "${label#*/}" "${label}" "${lock}"
    done <"${work}/history.list" | sort -r | cut -f2,3
}

plan() {
    local work product board previous label lock row generation
    work="${WORK}"
    history "${work}" >"${work}/history.tsv"
    scope_products >"${work}/products.tsv"
    while IFS=$'\t' read -r product board; do
        previous="-"; row=""
        while IFS=$'\t' read -r label lock; do
            row="$(awk -F'\t' -v p="${product}" '$1 == "product" && $2 == p' "${lock}")"
            [ -z "${row}" ] || { previous="${label}"; break; }
        done <"${work}/history.tsv"
        if [ "${previous}" = - ]; then
            printf '%s\t%s\t2\t-\t-\t-\n' "${product}" "${board}"
        else
            [[ "${previous#*/}" < "${RELEASE}" ]] || die "${product} was last released in ${previous}, which is not earlier than ${RELEASE}"
            IFS=$'\t' read -r _ _ _ _ generation _ kernel rootfs <<<"${row}"
            printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${product}" "${board}" "$((generation + 1))" "${previous}" "${kernel}" "${rootfs}"
        fi
    done <"${work}/products.tsv"
}

# The previous release's signed descriptor of <product>, from the head of its full update archive.
previous_descriptor() { # <product> <previous label> <out>
    local name="mica-$1-${2#*/}.micaupd" source header length
    if [ -n "${MICA_RELEASE_HISTORY:-}" ]; then
        source="${MICA_RELEASE_HISTORY}/${2%%/*}_${2#*/}/${name}"
        [ -f "${source}" ] || die "release $2 has no ${name}"
        header="$(head -c 12 "${source}" | od -An -tx1 | tr -d ' \n')"
    else
        source="https://github.com/micaoss/mica-build/releases/download/$2/${name}"
        header="$(curl -fsSL --max-time 120 -r 0-11 "${source}" | od -An -tx1 | tr -d ' \n')" || die "the head of ${name} of release $2 could not be read"
    fi
    [ "${header:0:16}" = 4d49434155504431 ] || die "${name} of release $2 is not a MICAUPD1 archive"
    length=$((16#${header:16:8}))
    [ "${length}" -gt 0 ] && [ "${length}" -le 1048576 ] || die "${name} of release $2 declares a descriptor of ${length} bytes"
    if [ -n "${MICA_RELEASE_HISTORY:-}" ]; then
        tail -c +13 "${source}" | head -c "${length}" >"$3"
    else
        curl -fsSL --max-time 120 -r "12-$((11 + length))" "${source}" >"$3" || die "the descriptor of ${name} of release $2 could not be read"
    fi
}

kernel_guard() { # <product> <previous label> <previous kernel id> <kernel id> <kernel buildId> <signing>
    local envelope="${WORK}/previous-envelope.json" identity="${WORK}/previous-identity.tsv" p b g d kernel r build_id
    previous_descriptor "$1" "$2" "${envelope}"
    rm -f "${identity}"
    bash build/run.sh --components identity --input "${envelope}" --public-key "$(tr -d '\n' <"$6/updates/public.key")" --out "${identity}" >/dev/null ||
        die "the descriptor of $1 in release $2 does not authenticate with this release's updates key"
    IFS=$'\t' read -r p b g d kernel r build_id <"${identity}"
    [ "${p}" = "$1" ] && [ "${kernel}" = "$3" ] || die "the descriptor of $1 in release $2 names ${p} kernel ${kernel}, not its product row's kernel $3"
    if [ "${build_id}" = "$5" ] && [ "${kernel}" != "$4" ]; then
        die "$1: the kernel buildId ${build_id} equals release $2's, and the kernel id $4 differs from its $3; the same inputs packed to other bytes"
    fi
}

# <raw image> <its sha256> <out .gz>: the deterministic compression of a raw image, checked both ways.
compress_image() {
    local raw="$1" sha="$2" gz="$3" answer started
    started="$(date +%s)"
    # mica-build-side: container-block -- gzip, cmp and sha256sum run in mica-build-env:base.
    answer="$(docker run --rm --label ai-agent=true --network none -v "$(realpath "$(dirname "${raw}")"):/raw:ro" -v "$(realpath "$(dirname "${gz}")"):/out" \
        "$(bash tools/from.sh --ref mica-build-env:base)" bash -c 'set -euo pipefail
            gzip -n -9 -c "/raw/$1" >"/out/$2.first"; gzip -n -9 -c "/raw/$1" >"/out/$2"
            cmp -s "/out/$2.first" "/out/$2" || { echo nondeterministic; exit 0; }
            rm "/out/$2.first"; chmod 0644 "/out/$2"
            echo "$(gzip -dc "/out/$2" | sha256sum | cut -d" " -f1) $(gzip -dc "/out/$2" | wc -c)"' _ "$(basename "${raw}")" "$(basename "${gz}")")" ||
        die "compressing $(basename "${raw}") failed"
    # mica-build-side: host
    [ "${answer}" != nondeterministic ] || die "gzip compressed $(basename "${raw}") to different bytes twice; the release fails"
    [ "${answer}" = "${sha} $(stat -c %s "${raw}")" ] ||
        die "$(basename "${gz}") decompresses to ${answer}, not the raw image's ${sha} $(stat -c %s "${raw}")"
    echo "release.sh: $(basename "${gz}"): $(stat -c %s "${raw}") bytes to $(stat -c %s "${gz}"), compressed twice and checked in $(($(date +%s) - started)) s"
}

collect() { # <product> <plan> <dir>
    local product="$1" planfile="$2" dir="$3" out line board generation previous prev_kernel prev_rootfs profile
    out="${MICA_RELEASE_PRODUCTS:-_out/products}/${product}"
    line="$(awk -F'\t' -v p="${product}" '$1 == p' "${planfile}")"
    [ -n "${line}" ] || die "the plan names no product ${product}"
    IFS=$'\t' read -r _ board generation previous prev_kernel prev_rootfs <<<"${line}"
    grep -qx "release ${RELEASE}" "${out}/receipt.txt" 2>/dev/null && grep -qx "generation ${generation}" "${out}/receipt.txt" ||
        die "${out} is not a build of release ${RELEASE} at generation ${generation} (tools/product-build.sh ${product} --release ${RELEASE} --generation ${generation})"
    profile="$(sed -n 's/^PROFILE=//p' "products/${product}/product.env" | tr -d '"')"
    local signing="${MICA_SIGNING_OUTPUT:-${REPO_ROOT}/meta}" identity p b g deployment kernel rootfs build_id
    identity="${WORK}/identity.tsv"
    bash build/run.sh --components identity --input "${out}/deployments/${generation}.json" --public-key "$(tr -d '\n' <"${signing}/updates/public.key")" --out "${identity}" >/dev/null
    IFS=$'\t' read -r p b g deployment kernel rootfs build_id <"${identity}"
    [ "${p}" = "${product}" ] && [ "${b}" = "${board}" ] && [ "${g}" = "${generation}" ] ||
        die "the signed deployment of ${out} names ${p} ${b} generation ${g}, not ${product} ${board} generation ${generation}"
    [ "${previous}" = - ] || kernel_guard "${product}" "${previous}" "${prev_kernel}" "${kernel}" "${build_id}" "${signing}"
    mkdir -p "${dir}/assets" "${dir}/rows"
    : >"${dir}/rows/${product}.uncompressed"
    printf 'product\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${product}" "${board}" "${profile}" "${generation}" "${deployment}" "${kernel}" "${rootfs}" >"${dir}/rows/${product}.tsv"
    local type table kind file sha name
    for type in image update; do
        table="${out}/kinds.tsv"; [ "${type}" = image ] || table="${out}/updates.tsv"
        [ -s "${table}" ] || die "${table} is empty; the product built no ${type} files"
        while IFS=$'\t' read -r kind file sha; do
            name="${file##*/}"
            case "${type}/${kind}" in
            update/root) [ "${prev_kernel}" = "${kernel}" ] || { echo "release.sh: ${product}: no root package, the kernel id differs from ${previous}"; continue; } ;;
            update/kernel) [ "${prev_rootfs}" = "${rootfs}" ] || { echo "release.sh: ${product}: no kernel package, the rootfs id differs from ${previous}"; continue; } ;;
            esac
            [[ "${name}" == "mica-${product}-${RELEASE}."* ]] || die "${out}/${file} is not named mica-${product}-${RELEASE}.<suffix>"
            [ "$(sha256sum "${out}/${file}" | cut -d' ' -f1)" = "${sha}" ] || die "${out}/${file} does not hash to its ${table##*/} row"
            if [ "${type}" = image ]; then
                compress_image "${out}/${file}" "${sha}" "${dir}/assets/${name}.gz"
                printf '%s\t%s\t%s\n' "${kind}" "${sha}" "$(stat -c %s "${out}/${file}")" >>"${dir}/rows/${product}.uncompressed"
                name="${name}.gz"; sha="$(sha256sum "${dir}/assets/${name}" | cut -d' ' -f1)"
            else
                cp "${out}/${file}" "${dir}/assets/${name}"
            fi
            [ "$(stat -c %s "${dir}/assets/${name}")" -le "${MAX_ASSET}" ] || die "${name} is over 2 GiB, a GitHub Release asset's limit; the product's release fails"
            printf 'asset\t%s\t%s\t%s\t%s\t%s\n' "${product}" "${type}" "${kind}" "${name}" "${sha}" >>"${dir}/rows/${product}.tsv"
        done <"${table}"
    done
    grep -q $'^asset\t[^\t]*\tupdate\tfull\t' "${dir}/rows/${product}.tsv" || die "${product} built no full update package"
    echo "release.sh: ${product} collected for ${SCOPE}/${RELEASE} (generation ${generation})"
}

publish() { # <dir>
    local dir="$1" rows product type digest work repo=mica-build commit n
    registry_load
    work="${WORK}"
    commit="$(git rev-parse HEAD)"
    : >"${work}/rows"
    n=0
    for rows in "${dir}"/rows/*.tsv; do
        [ -f "${rows}" ] || continue
        n=$((n + 1))
        product="$(basename "${rows}" .tsv)"
        cat "${rows}" >>"${work}/rows"
        IFS=$'\t' read -r _ _ _ _ generation deployment _ _ < <(grep $'^product\t' "${rows}")
        for type in image update; do
            : >"${work}/layers.tsv"
            while IFS=$'\t' read -r _ _ _ kind name sha; do
                if [ "${type}" = image ]; then
                    IFS=$'\t' read -r _ raw_sha raw_size < <(awk -F'\t' -v k="${kind}" '$1 == k' "${dir}/rows/${product}.uncompressed")
                    [ -n "${raw_sha:-}" ] || die "${product}: no uncompressed identity for its ${kind} image"
                    annotations="$(jq -cn --arg t "${name}" --arg k "${kind}" --arg s "${raw_sha}" --arg n "${raw_size}" \
                        '{"org.opencontainers.image.title": $t, "mica.image-kind": $k, "mica.compression": "gzip", "mica.uncompressed-sha256": $s, "mica.uncompressed-size": $n}')"
                else
                    annotations="$(jq -cn --arg t "${name}" --arg k "${kind}" --arg d "${deployment}" --arg g "${generation}" \
                        '{"org.opencontainers.image.title": $t, "mica.update-kind": $k, "mica.deployment-id": $d, "mica.generation": $g}')"
                fi
                printf '%s\t%s\t%s\n' "${dir}/assets/${name}" application/octet-stream "${annotations}" >>"${work}/layers.tsv"
            done < <(awk -F'\t' -v p="${product}" -v t="${type}" '$1 == "asset" && $2 == p && $3 == t' "${rows}")
            digest="$(registry_publish "${repo}" "${type}.${product}.${RELEASE}" "application/vnd.mica.${type}" "${work}/layers.tsv")" ||
                die "publishing ${type}.${product}.${RELEASE} failed (see above)"
            # Read back anonymously: the manifest by digest, and every layer it names.
            status="$(registry_public_manifest "${repo}" "${digest}" "${work}/manifest.json")"
            [ "${status}" = 200 ] && [ "sha256:$(sha256sum "${work}/manifest.json" | cut -d' ' -f1)" = "${digest}" ] ||
                die "${REGISTRY_HOST}/${REGISTRY_OWNER}/${repo}:${type}.${product}.${RELEASE} does not read back anonymously as ${digest} (HTTP ${status}); a new package is private until it is made public in its package settings, then rerun"
            while IFS= read -r layer; do
                status="$(registry_public_blob "${repo}" "${layer}")"
                [ "${status}" = 200 ] || die "a layer of ${type}.${product}.${RELEASE} does not read back anonymously at ${layer} (HTTP ${status})"
                awk -F'\t' -v p="${product}" -v t="${type}" -v s="${layer#sha256:}" '$1 == "asset" && $2 == p && $3 == t && $6 == s { f = 1 } END { exit !f }' "${rows}" ||
                    die "the layer ${layer} of ${type}.${product}.${RELEASE} is no asset row"
            done < <(jq -r '.layers[].digest' "${work}/manifest.json")
            printf 'bundle\t%s\t%s\tghcr.io/micaoss/%s:%s.%s.%s@%s\n' "${product}" "${type}" "${repo}" "${type}" "${product}" "${RELEASE}" "${digest}" >>"${work}/rows"
        done
    done
    [ "${n}" -gt 0 ] || die "${dir}/rows holds no collected product"
    # The inputs: every pin but the mica-boards pins of boards outside the scope's products.
    local boards pin name input
    boards=" $(awk -F'\t' '$1 == "product" { print $3 }' "${work}/rows" | sort -u | tr '\n' ' ')"
    for pin in locks/pins/*.pin; do
        name="$(basename "${pin}" .pin)"
        case "${name}" in mica-boards.*) [[ "${boards}" == *" ${name#mica-boards.} "* ]] || continue ;; esac
        input="$(printf '%s\t%s\t%s' "input" "${name}" "$(sed -n 's/^RELEASE=//p' "${pin}")")"
        printf '%s\t%s\n' "${input}" "$(sed -n 's/^SHA256SUMS=//p' "${pin}")" >>"${work}/rows"
    done
    {
        printf '# mica-lock v1\n'
        printf 'release\tmica-build\t%s/%s\t%s\n' "${SCOPE}" "${RELEASE}" "${commit}"
        python3 - "${work}/rows" <<'PY'
import sys
order = ['input', 'product', 'bundle', 'asset']
width = {'input': 1, 'product': 1, 'bundle': 2, 'asset': 3}
rows = [line.rstrip('\n').split('\t') for line in open(sys.argv[1]) if line.strip()]
rows.sort(key=lambda r: (order.index(r[0]),) + tuple(k.encode() for k in r[1:1 + width[r[0]]]))
for r in rows:
    print('\t'.join(r))
PY
    } >"${dir}/mica-build.lock"
    python3 tools/locks.py lock "${dir}/mica-build.lock" >/dev/null || die "the written mica-build.lock breaks a rule (see above)"
    (cd "${dir}" && sha256sum mica-build.lock >SHA256SUMS)
    cat "${dir}/mica-build.lock"
}

attach() { # <dir>
    local dir="$1" tag="${SCOPE}/${RELEASE}" name
    [ -f "${dir}/mica-build.lock" ] && [ -f "${dir}/SHA256SUMS" ] || die "${dir} holds no published lock (tools/release.sh publish)"
    # Assets first, the lock and SHA256SUMS last; an existing asset is never replaced.
    gh release upload "${tag}" "${dir}"/assets/* --repo micaoss/mica-build
    gh release upload "${tag}" "${dir}/mica-build.lock" "${dir}/SHA256SUMS" --repo micaoss/mica-build
    for name in $(awk -F'\t' '$1 == "asset" { print $5 }' "${dir}/mica-build.lock") mica-build.lock SHA256SUMS; do
        local want
        want="$(sha256sum "$( [ -f "${dir}/assets/${name}" ] && echo "${dir}/assets/${name}" || echo "${dir}/${name}")" | cut -d' ' -f1)"
        [ "$(curl -fsSL --max-time 3600 "https://github.com/micaoss/mica-build/releases/download/${tag}/${name}" | sha256sum | cut -d' ' -f1)" = "${want}" ] ||
            die "${name} of release ${tag} does not read back anonymously with its bytes"
    done
    echo "release.sh: ${tag} attached and read back"
}

cmd="${1:-}"; [ "$#" -eq 0 ] || shift
mkdir -p "${REPO_ROOT}/_out"
WORK="$(mktemp -d "${REPO_ROOT}/_out/.release.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
case "${cmd}" in
plan) [ "$#" -eq 1 ] || die "usage: plan <scope>/<YYYYMMDD-HHMM>"; tag_parts "$1"; plan ;;
collect) [ "$#" -eq 4 ] || die "usage: collect <product> <scope>/<YYYYMMDD-HHMM> <plan> <dir>"; tag_parts "$2"; collect "$1" "$3" "$4" ;;
publish) [ "$#" -eq 2 ] || die "usage: publish <scope>/<YYYYMMDD-HHMM> <dir>"; tag_parts "$1"; publish "$2" ;;
attach) [ "$#" -eq 2 ] || die "usage: attach <scope>/<YYYYMMDD-HHMM> <dir>"; tag_parts "$1"; attach "$2" ;;
*) die "usage: bash tools/release.sh plan|collect|publish|attach ..." ;;
esac
