#!/usr/bin/env bash
# A scoped mica-build release (mica:docs/decisions/2026-09-15-mica-build-scoped-releases.md,
# mica:docs/design/release-lock.md 1.2.2): <scope>.<YYYYMMDD-HHMM>, a board (all its products) or one product.
# The scope and the stamp are separated by a dot (mica:docs/decisions/2026-09-16-scoped-tags-use-a-dot.md);
# the retired <scope>/<stamp> form is no release tag of this repository and nothing reads it.
#
#   bash tools/release.sh plan <scope>.<YYYYMMDD-HHMM>   (MICA_RELEASE_GENERATIONS="<product>=<generation> ...")
#       one line per product of the scope: product, board, generation, previous release (or -),
#       its kernel id and rootfs id (or -); the generation is one above the previous release's
#       product row, 2 for a product's first release
#   bash tools/release.sh collect <product> <scope>.<YYYYMMDD-HHMM> <plan> <dir>
#       the built product (tools/product-build.sh <product> --release <YYYYMMDD-HHMM> --generation <g>)
#       into <dir>: its image and update files under <dir>/assets and its rows under <dir>/rows
#   bash tools/release.sh publish <scope>.<YYYYMMDD-HHMM> <dir>
#       per product the OCI bundles image.<product>.<release> and update.<product>.<release>, read back
#       anonymously; then <dir>/mica-build.lock and <dir>/SHA256SUMS listing only it
#   bash tools/release.sh attach <scope>.<YYYYMMDD-HHMM> <dir>
#       the assets, then the lock and SHA256SUMS last, to the GitHub Release, read back anonymously
#   bash tools/release.sh index [--dry-run] [<scope>.<YYYYMMDD-HHMM>]
#       the Mica version index mica.<YYYYMMDD-HHMM> at this checkout's commit (release.yml's index job, after the
#       scoped release it names) as mica-build.lock and mica-index.json (tools/release-index.py) with SHA256SUMS
#       listing both; cut as a draft, checked, published as the latest release and read back anonymously.
#       The first index is built in full: the newest scoped release of every published product, each checked.
#       Every later one is incremental: the previous index (the newest mica.*, its files proved by its SHA256SUMS
#       and its JSON by its lock) with its entries carried unread, the named release entering or replacing the
#       entries of its products with every cross-release check, and the entries of products no longer published
#       dropped; nothing entering or leaving cuts nothing. --dry-run builds and checks, uploads nothing.
#       mica.* is never cut by hand: plan, collect, publish and attach refuse the scope mica.
#   bash tools/release.sh verify-index mica.<YYYYMMDD-HHMM> [--full]
#       at the index's commit, publishing nothing: its files read anonymously and the index rebuilt from its
#       previous index and the release that entered it; --full rebuilds every entry from the releases it references
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
#   env     MICA_REGISTRY (tools/registry.sh), GH_TOKEN for attach, MICA_RELEASE_GENERATIONS (plan, a generation floor)
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
    [[ "$1" =~ ^([a-z0-9][a-z0-9-]*)\.([0-9]{8}-[0-9]{4})$ ]] || die "the release tag must be <scope>.<YYYYMMDD-HHMM>, not '$1'"
    SCOPE="${BASH_REMATCH[1]}"; RELEASE="${BASH_REMATCH[2]}"
    [ "${SCOPE}" != mica ] || die "mica.* releases are cut by the index job of a scoped release, never by hand"
}

# The products of the scope, one per line: a product's own name, or every product of a board. Whether the scope's
# board is a release target is the release job's check (.github/workflows/release-product.yml), which reads the
# fetched board.env; this reads products/ alone.
scope_products() {
    local p board found=""
    for p in $(bash tools/product.sh --list); do
        board="$(sed -n 's/^BOARD=//p' "products/${p}/product.env" | tr -d '"')"
        [ "${p}" = "${SCOPE}" ] || [ "${board}" = "${SCOPE}" ] || continue
        found=1
        printf '%s\t%s\n' "${p}" "${board}"
    done
    [ -n "${found}" ] || die "the scope ${SCOPE} is neither a product nor the board of a product"
}

# Every earlier release's lock, newest first: <release label> TAB <lock path>. Each lock is the one its
# SHA256SUMS lists, and a valid lock. The release being built and a release with no asset at all (one
# whose run failed before attaching, since the lock is attached last) are not earlier releases; a
# release with assets and without both of these is refused, never skipped.
history() { # <work> [<release label>...]: every earlier release, or only the named ones
    local work="$1" label dir n=0
    shift
    mkdir -p "${work}/downloads"
    if [ -n "${MICA_RELEASE_HISTORY:-}" ]; then
        for dir in "${MICA_RELEASE_HISTORY}"/*.*; do
            [ -d "${dir}" ] || continue
            label="$(basename "${dir}")"
            [ "${label}" != "${SCOPE}.${RELEASE}" ] && [ -n "$(ls -A "${dir}")" ] || continue
            [ "$#" -eq 0 ] || [[ " $* " == *" ${label} "* ]] || continue
            printf '%s\t%s\t%s\n' "${label}" "${dir}/mica-build.lock" "${dir}/SHA256SUMS"
        done >"${work}/history.list"
        for label in "$@"; do
            grep -q "^${label}"$'\t' "${work}/history.list" || die "release ${label} has no lock to read"
        done
    else
        : >"${work}/history.list"
        if [ "$#" -gt 0 ]; then
            printf '%s\n' "$@" >"${work}/labels"
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
            jq -r --arg self "${SCOPE}.${RELEASE}" 'select((.draft | not) and .tag_name != $self and (.assets | length) > 0) | .tag_name' "${work}/releases.json" |
                { grep -E '^[a-z0-9][a-z0-9-]*\.[0-9]{8}-[0-9]{4}$' || true; } >"${work}/labels"
        fi
        while IFS= read -r label; do
            n=$((n + 1)); dir="${work}/downloads/${n}"; mkdir -p "${dir}"
            for asset in mica-build.lock SHA256SUMS $([[ "${label}" != mica.* ]] || echo mica-index.json); do
                curl -fsSL --retry 3 --retry-all-errors --max-time 120 -o "${dir}/${asset}" "https://github.com/micaoss/mica-build/releases/download/${label}/${asset}" ||
                    die "release ${label} of micaoss/mica-build has no readable ${asset}; an earlier release without its lock is refused"
            done
            printf '%s\t%s\t%s\n' "${label}" "${dir}/mica-build.lock" "${dir}/SHA256SUMS" >>"${work}/history.list"
        done <"${work}/labels"
    fi
    while IFS=$'\t' read -r label lock sums; do
        # A scoped release's SHA256SUMS lists its lock; an index's lists its lock and mica-index.json.
        local listed="$(sha256sum "${lock}" 2>/dev/null | cut -d' ' -f1)  mica-build.lock"
        [[ "${label}" != mica.* ]] || listed="${listed}"$'\n'"$(sha256sum "$(dirname "${lock}")/mica-index.json" 2>/dev/null | cut -d' ' -f1)  mica-index.json"
        [ "$(cat "${sums}" 2>/dev/null)" = "${listed}" ] ||
            die "release ${label}: SHA256SUMS does not list exactly its mica-build.lock$([[ "${label}" != mica.* ]] || echo ' and mica-index.json')"
        python3 tools/locks.py lock "${lock}" >/dev/null || die "release ${label}: its mica-build.lock breaks a rule (see above)"
        [ "$(awk -F'\t' '$1 == "release" { print $3 }' "${lock}")" = "${label}" ] || die "release ${label}: its lock names another release"
        printf '%s\t%s\t%s\t%s\n' "${label#*.}" "${label}" "${lock}" "${sums}"
    done <"${work}/history.list" | sort -r | cut -f2-
}

# The scoped releases later than <stamp>, other than the release being built and a release with no asset at all:
# the tags of micaoss/mica-build (each checked for assets), or the directories of MICA_RELEASE_HISTORY.
releases_after() { # <stamp>
    local label
    if [ -n "${MICA_RELEASE_HISTORY:-}" ]; then
        find "${MICA_RELEASE_HISTORY}" -mindepth 1 -maxdepth 1 -type d -name '*.*' ! -name 'mica.*' ! -empty -printf '%f\n'
    else
        git ls-remote --tags https://github.com/micaoss/mica-build 'refs/tags/*' | cut -f2 | sed 's|^refs/tags/||' | { grep -E '^[a-z0-9][a-z0-9-]*\.[0-9]{8}-[0-9]{4}$' || true; }
    fi | while IFS= read -r label; do
        [[ "${label}" != mica.* ]] && [[ "${label#*.}" > "$1" ]] && [ "${label}" != "${SCOPE}.${RELEASE}" ] || continue
        if [ -z "${MICA_RELEASE_HISTORY:-}" ]; then
            [ "$(gh_release_assets "${label}")" -gt 0 ] || continue
        fi
        printf '%s\n' "${label}"
    done | sort
}

gh_release_assets() { # <label>: the asset count of a published release (0 for a draft or none)
    local auth=()
    [ -z "${GH_TOKEN:-}" ] || auth=(-H "Authorization: Bearer ${GH_TOKEN}")
    curl -fsS --max-time 60 "${auth[@]}" "https://api.github.com/repos/micaoss/mica-build/releases/tags/$1" | jq '.assets | length' ||
        die "release $1 of micaoss/mica-build could not be read"
}

# <product> <history.tsv> -> PREVIOUS (its newest release label, or -) and ROW (that release's product row).
previous_release() {
    local label lock
    PREVIOUS="-"; ROW=""
    while IFS=$'\t' read -r label lock _; do
        ROW="$(awk -F'\t' -v p="$1" '$1 == "product" && $2 == p' "${lock}")"
        [ -n "${ROW}" ] || continue
        PREVIOUS="${label}"
        if [[ "${label}" == mica.* ]]; then
            # An index entry: the scoped release its index row names.
            PREVIOUS="$(awk -F'\t' -v p="$1" '$1 == "index" && $2 == p { i = $3 } $1 == "input" { r[$2] = $3 } END { sub(/^mica-build\./, "", i); print i "." r["mica-build." i] }' "${lock}")"
        fi
        return 0
    done <"$2"
}

# Each product's previous release: before any index exists, the newest of every earlier release; after, the newest
# of the newest index's entries and every scoped release later than that index (an index job may still be pending).
# A product in neither (dropped from the index and published again, or never indexed) is looked up in every earlier
# release, so its generation stays above any it was ever released at.
plan() {
    local work product board generation index item planned
    # MICA_RELEASE_GENERATIONS="<product>=<generation> ..." is a floor for a history this repository can no longer
    # read -- the first release in the dot tag form, whose slash-form predecessors are no release tags any more. It
    # never lowers a generation: a floor below the planned one is refused, so a device is never offered a
    # generation it already runs. Read here, not in a command substitution, where a refusal would exit a subshell.
    local -A floor=()
    for item in ${MICA_RELEASE_GENERATIONS:-}; do
        [[ "${item}" =~ ^[a-z0-9][a-z0-9-]*=[2-9][0-9]*$ ]] ||
            die "MICA_RELEASE_GENERATIONS holds '${item}'; each item is <product>=<generation>, a decimal of at least 2"
        floor["${item%%=*}"]="${item#*=}"
    done
    work="${WORK}"
    index="$(newest_index)"
    if [ -z "${index}" ]; then
        history "${work}" >"${work}/history.tsv"
    else
        # shellcheck disable=SC2046
        history "${work}" "${index}" $(releases_after "${index#mica.}") >"${work}/history.tsv"
    fi
    scope_products >"${work}/products.tsv"
    while IFS=$'\t' read -r product board; do
        previous_release "${product}" "${work}/history.tsv"
        if [ "${PREVIOUS}" = - ] && [ -n "${index}" ]; then
            if [ ! -f "${work}/full/history.tsv" ]; then
                mkdir -p "${work}/full"
                history "${work}/full" >"${work}/full/history.tsv"
            fi
            previous_release "${product}" "${work}/full/history.tsv"
        fi
        if [ "${PREVIOUS}" = - ]; then
            planned=2
        else
            [[ "${PREVIOUS#*.}" < "${RELEASE}" ]] || die "${product} was last released in ${PREVIOUS}, which is not earlier than ${RELEASE}"
            IFS=$'\t' read -r _ _ _ _ generation _ kernel rootfs <<<"${ROW}"
            planned="$((generation + 1))"
        fi
        if [ -n "${floor[${product}]:-}" ]; then
            [ "${floor[${product}]}" -ge "${planned}" ] ||
                die "MICA_RELEASE_GENERATIONS gives ${product} generation ${floor[${product}]}, below the planned ${planned}; a generation never goes down"
            planned="${floor[${product}]}"
        fi
        if [ "${PREVIOUS}" = - ]; then
            printf '%s\t%s\t%s\t-\t-\t-\n' "${product}" "${board}" "${planned}"
        else
            printf '%s\t%s\t%s\t%s\t%s\t%s\n' "${product}" "${board}" "${planned}" "${PREVIOUS}" "${kernel}" "${rootfs}"
        fi
    done <"${work}/products.tsv"
}

# The previous release's signed descriptor of <product>, from the head of its full update archive.
previous_descriptor() { # <product> <previous label> <out>
    local name="mica-$1-${2#*.}.micaupd" source header length
    if [ -n "${MICA_RELEASE_HISTORY:-}" ]; then
        source="${MICA_RELEASE_HISTORY}/$2/${name}"
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
        head -c "$((12 + length))" "${source}" | tail -c "${length}" >"$3"
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
    echo "release.sh: ${product} collected for ${SCOPE}.${RELEASE} (generation ${generation})"
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
        printf 'release\tmica-build\t%s.%s\t%s\n' "${SCOPE}" "${RELEASE}" "${commit}"
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
    local dir="$1" tag="${SCOPE}.${RELEASE}" name
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

# The asset at <release label>/<file>: its size from a HEAD of the download, or from MICA_RELEASE_ASSETS=<dir> of
# <scope>_<YYYYMMDD-HHMM>/<file> (the tests).
asset_size() { # <label> <file>
    if [ -n "${MICA_RELEASE_ASSETS:-}" ]; then
        stat -c %s "${MICA_RELEASE_ASSETS}/$1/$2"
    else
        curl -fsSIL --max-time 120 "https://github.com/micaoss/mica-build/releases/download/$1/$2" | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { if (n == "") exit 1; print n }'
    fi
}

# The newest index release, or nothing: the mica.* tags of micaoss/mica-build (a tag is created when a release is
# published), or the mica.* directories of MICA_RELEASE_HISTORY. A tag of the retired <scope>/<stamp> form is no
# release tag here, so the first index after the change is built in full.
newest_index() {
    if [ -n "${MICA_RELEASE_HISTORY:-}" ]; then
        find "${MICA_RELEASE_HISTORY}" -mindepth 1 -maxdepth 1 -type d -name 'mica.*' -printf '%f\n' | sort | tail -1
    else
        git ls-remote --tags https://github.com/micaoss/mica-build 'refs/tags/mica.*' | cut -f2 | sed 's|^refs/tags/||' |
            { grep -E '^mica\.[0-9]{8}-[0-9]{4}$' || true; } | sort | tail -1
    fi
}

index() { # [--dry-run] [<scope>.<YYYYMMDD-HHMM>]
    local dry="" entering="" work="${WORK}" commit stamp code tries=0 label file size ref digest status out="${WORK}/index" previous mode board
    [ "${1:-}" != --dry-run ] || { dry=--dry-run; shift; }
    [ "$#" -eq 0 ] || { entering="$1"; tag_parts "${entering}"; }
    commit="$(git rev-parse HEAD)"
    [ -z "$(git status --porcelain)" ] || die "an index is cut from a clean checkout"
    SCOPE=mica; RELEASE=00000000-0000
    previous="$(newest_index)"
    if [ -z "${previous}" ] || [ -n "${MICA_INDEX_FULL:-}" ]; then
        # The first index, or the verifier's full rebuild (a history of exactly the references and the previous index).
        mode=full
        history "${work}" >"${work}/history.tsv"
    else
        mode=incremental
        history "${work}" "${previous}" ${entering:+"${entering}"} >"${work}/history.tsv"
    fi
    # The catalogue: every pinned board, its release-target flag out of its board component's board.env.
    : >"${work}/boards.tsv"
    while IFS=$'\t' read -r input board arch ref; do
        local env="${work}/board-${board}.env"
        if [ -n "${MICA_INDEX_BOARD_ENV_DIR:-}" ]; then
            cp "${MICA_INDEX_BOARD_ENV_DIR}/${board}/board.env" "${env}"
        else
            blob="$(jq -r '.layers[] | select(.annotations["org.opencontainers.image.title"] == "board.env") | .digest' "$(bash tools/oci.sh manifest "${ref}")")"
            bash tools/oci.sh blob "${ref%%[:@]*}" "${blob#sha256:}" "${env}" || die "the board.env of ${board} could not be read"
        fi
        printf '%s\t%s\t%s\t%s\t%s\n' "${board}" "${arch}" "$(grep -qx 'BOARD_RELEASE_TARGET=1' "${env}" && echo 1 || echo 0)" \
            "$(python3 tools/locks.py pin "${input}" | sed -n 's/^RELEASE=//p')" "$(python3 tools/locks.py pin "${input}" | sed -n 's/^SHA256SUMS=//p')" >>"${work}/boards.tsv"
    done < <(python3 tools/locks.py rows board | awk -F'\t' '$3 == "board" { print $1 "\t" $2 "\t" $4 "\t" $5 }')
    # A product is published when its board is a release target (mica:docs/design/mica-index.md 3.1); there is no
    # per-product switch (user, 2026-09-16, with the minimal products).
    : >"${work}/products.tsv"
    for product in $(bash tools/product.sh --list); do
        env_of() { sed -n "s/^$1=//p" "products/${product}/product.env" | tr -d '"'; }
        board="$(env_of BOARD)"
        printf '%s\t%s\t%s\t%s\t%s\n' "${product}" "${board}" "$(env_of PROFILE)" "$(env_of FEATURES)" \
            "$(awk -F'\t' -v b="${board}" '$1 == b { print $3 }' "${work}/boards.tsv")" >>"${work}/products.tsv"
    done
    mkdir -p "${out}"
    while :; do
        stamp="${MICA_INDEX_STAMP:-$(date -u +%Y%m%d-%H%M)}"
        code=0
        python3 tools/release-index.py lock "${work}/history.tsv" "${work}/products.tsv" "${stamp}" "${commit}" "${mode}" "${out}/mica-build.lock" "${work}/entering.tsv" || code=$?
        [ "${code}" = 4 ] && [ -z "${MICA_INDEX_STAMP:-}" ] && [ "${tries}" -lt 2 ] || break
        # The minute is not later than a reference or the previous index: wait for the next one.
        tries=$((tries + 1)); sleep "$((61 - 10#$(date -u +%S)))"
    done
    if [ "${code}" = 5 ]; then echo "release.sh: no index is cut (see above)"; return 0; fi
    [ "${code}" = 0 ] || die "the index of ${stamp} was refused (see above)"
    python3 tools/locks.py lock "${out}/mica-build.lock" >/dev/null || die "the index lock breaks a rule (see above)"
    # The entering entries only: every bundle manifest, read anonymously by digest, and every asset's size, read anonymously.
    registry_load
    : >"${work}/layers.tsv"; : >"${work}/assets.tsv"
    while IFS=$'\t' read -r product label; do
        while IFS= read -r ref; do
            digest="${ref##*@}"
            status="$(registry_public_manifest mica-build "${digest}" "${work}/${digest#sha256:}.json")"
            [ "${status}" = 200 ] && [ "sha256:$(sha256sum "${work}/${digest#sha256:}.json" | cut -d' ' -f1)" = "${digest}" ] ||
                die "the bundle ${ref} does not read back anonymously as ${digest} (HTTP ${status})"
            while IFS= read -r layer; do
                status="$(registry_public_blob mica-build "${layer}")"
                [ "${status}" = 200 ] || die "a layer of ${ref} does not read back anonymously at ${layer} (HTTP ${status})"
            done < <(jq -r '.layers[].digest' "${work}/${digest#sha256:}.json")
            printf '%s\t%s\n' "${ref}" "${work}/${digest#sha256:}.json" >>"${work}/layers.tsv"
        done < <(awk -F'\t' -v p="${product}" '$1 == "bundle" && $2 == p { print $4 }' "${out}/mica-build.lock")
        while IFS= read -r file; do
            size="$(asset_size "${label}" "${file}")" || die "the asset ${file} of release ${label} does not read back anonymously"
            printf '%s\t%s\t%s\n' "${label}" "${file}" "${size}" >>"${work}/assets.tsv"
        done < <(awk -F'\t' -v p="${product}" '$1 == "asset" && $2 == p { print $5 }' "${out}/mica-build.lock")
    done <"${work}/entering.tsv"
    python3 tools/release-index.py json "${out}/mica-build.lock" "${work}/history.tsv" "${work}/entering.tsv" "${work}/products.tsv" "${work}/boards.tsv" \
        "${work}/layers.tsv" "${work}/assets.tsv" "${MICA_RELEASE_DOWNLOADS:-https://github.com/micaoss/mica-build/releases/download}" "${out}/mica-index.json" ||
        die "the index JSON was refused (see above)"
    (cd "${out}" && sha256sum mica-build.lock mica-index.json >SHA256SUMS)
    local tag="mica.${stamp}"
    echo "release.sh: ${tag}: ${mode}, $(grep -c $'^index\t' "${out}/mica-build.lock") product(s) from $(grep -c $'^input\t' "${out}/mica-build.lock") release(s), $(wc -l <"${work}/entering.tsv") entering$([ "${mode}" = full ] || echo ", the rest carried from ${previous}") in ${SECONDS} s; SHA256SUMS $(sha256sum "${out}/SHA256SUMS" | cut -d' ' -f1)"
    cat "${out}/mica-build.lock"
    if [ -n "${MICA_INDEX_OUT:-}" ]; then mkdir -p "${MICA_INDEX_OUT}" && cp "${out}"/* "${MICA_INDEX_OUT}/"; fi
    [ "${dry}" != --dry-run ] || { echo "release.sh: ${tag}: dry run, nothing uploaded"; return 0; }
    # A draft first, the three files, their digests checked, then published as the latest release and read back anonymously.
    gh release create "${tag}" --repo micaoss/mica-build --draft --target "${commit}" --title "${tag}" \
        --notes "Mica version ${tag#mica.}: the index of the scoped releases of every published product (mica-index.json, mica-build.lock)."
    gh release upload "${tag}" "${out}/mica-build.lock" "${out}/mica-index.json" "${out}/SHA256SUMS" --repo micaoss/mica-build
    for file in mica-build.lock mica-index.json SHA256SUMS; do
        [ "$(gh api 'repos/micaoss/mica-build/releases?per_page=100' --jq ".[] | select(.tag_name == \"${tag}\") | .assets[] | select(.name == \"${file}\") | .digest")" = "sha256:$(sha256sum "${out}/${file}" | cut -d' ' -f1)" ] ||
            die "${file} of the draft ${tag} does not carry its digest; the draft is left unpublished"
    done
    gh release edit "${tag}" --repo micaoss/mica-build --draft=false --latest
    for file in mica-build.lock mica-index.json SHA256SUMS; do
        [ "$(curl -fsSL --max-time 300 "https://github.com/micaoss/mica-build/releases/download/${tag}/${file}" | sha256sum | cut -d' ' -f1)" = "$(sha256sum "${out}/${file}" | cut -d' ' -f1)" ] ||
            die "${file} of release ${tag} does not read back anonymously with its bytes"
    done
    echo "release.sh: ${tag} published as the latest release and read back in ${SECONDS} s"
    verify_index "${tag}"
}

# An index release, verified independently and anonymously, publishing nothing: its three files, then the index
# rebuilt at its own commit and stamp, byte-identical to the published lock and mica-index.json. By default the
# rebuild is the incremental one of its cut: its previous index (trusted by the hash its JSON names) and the release
# that entered. --full rebuilds every entry from every release it references (each trusted by its SHA256SUMS hash).
verify_index() { # <mica.YYYYMMDD-HHMM> [--full]
    local tag="$1" full="${2:-}" got="${WORK}/verify/got" history="${WORK}/verify/history" rebuilt="${WORK}/verify/rebuilt" file input release scope previous
    local downloads="${MICA_RELEASE_DOWNLOADS:-https://github.com/micaoss/mica-build/releases/download}"
    [[ "${tag}" =~ ^mica\.[0-9]{8}-[0-9]{4}$ ]] || die "verify-index takes mica.<YYYYMMDD-HHMM>, not '${tag}'"
    mkdir -p "${got}" "${history}" "${rebuilt}"
    for file in mica-build.lock mica-index.json SHA256SUMS; do
        curl -fsSL --retry 3 --retry-all-errors --max-time 300 -o "${got}/${file}" "${downloads}/${tag}/${file}" || die "${file} of ${tag} does not read back anonymously"
    done
    [ "$(cat "${got}/SHA256SUMS")" = "$(cd "${got}" && sha256sum mica-build.lock mica-index.json)" ] || die "SHA256SUMS of ${tag} does not list exactly its lock and mica-index.json"
    python3 tools/locks.py lock "${got}/mica-build.lock" >/dev/null || die "the lock of ${tag} breaks a rule (see above)"
    [ "$(awk -F'\t' '$1 == "release" { print $4 }' "${got}/mica-build.lock")" = "$(git rev-parse HEAD)" ] && [ -z "$(git status --porcelain)" ] ||
        die "verify ${tag} from a clean checkout of its commit $(awk -F'\t' '$1 == "release" { print $4 }' "${got}/mica-build.lock")"
    fetch() { # <label> <file...>
        local label="$1" dir="${history}/$1"; shift
        mkdir -p "${dir}"
        for file in "$@"; do
            curl -fsSL --retry 3 --retry-all-errors --max-time 300 -o "${dir}/${file}" "${downloads}/${label}/${file}" || die "${file} of ${label}, referenced by ${tag}, does not read back anonymously"
        done
    }
    previous="$(jq -r '.previous.release // empty' "${got}/mica-index.json")"
    if [ -n "${previous}" ]; then
        fetch "${previous}" mica-build.lock mica-index.json SHA256SUMS
        [ "$(sha256sum "${history}/${previous}/SHA256SUMS" | cut -d' ' -f1)" = "$(jq -r .previous.trust "${got}/mica-index.json")" ] ||
            die "the previous index ${previous} of ${tag} no longer has the SHA256SUMS hash ${tag} names"
    fi
    local entering=() args=(--dry-run)
    while IFS=$'\t' read -r input release _; do
        scope="${input#mica-build.}"
        if [ -z "${full}" ] && [ -n "${previous}" ] && awk -F'\t' -v i="${input}" -v r="${release}" '$1 == "input" && $2 == i && $3 == r { f = 1 } END { exit !f }' "${history}/${previous}/mica-build.lock"; then
            continue
        fi
        fetch "${scope}.${release}" mica-build.lock SHA256SUMS
        entering+=("${scope}.${release}")
    done < <(awk -F'\t' '$1 == "input" { print $2 "\t" $3 "\t" $4 }' "${got}/mica-build.lock")
    if [ -z "${full}" ] && [ -n "${previous}" ]; then
        [ "${#entering[@]}" -le 1 ] || die "${tag} names ${#entering[@]} releases not in its previous index ${previous}; an index job enters one"
        args+=("${entering[@]}")
    fi
    env MICA_RELEASE_HISTORY="${history}" MICA_INDEX_STAMP="${tag#mica.}" MICA_INDEX_OUT="${rebuilt}" ${full:+MICA_INDEX_FULL=1} \
        bash tools/release.sh index "${args[@]}" >"${WORK}/verify/rebuild.log" 2>&1 ||
        { cat "${WORK}/verify/rebuild.log" >&2; die "${tag} could not be rebuilt from the releases it references"; }
    for file in mica-build.lock mica-index.json; do
        cmp -s "${got}/${file}" "${rebuilt}/${file}" || die "${file} of ${tag} differs from the index rebuilt from its references"
    done
    echo "release.sh: ${tag} verified$([ -z "${full}" ] || echo ' in full'): SHA256SUMS $(sha256sum "${got}/SHA256SUMS" | cut -d' ' -f1), the lock and the JSON rebuilt byte-identically from $([ -n "${full}" ] || [ -z "${previous}" ] && echo "its $(grep -c $'^input\t' "${got}/mica-build.lock") referenced release(s)" || echo "${previous} and ${#entering[@]} entering release(s)")$([ -z "${previous}" ] || echo ", previous ${previous}")"
}

cmd="${1:-}"; [ "$#" -eq 0 ] || shift
mkdir -p "${REPO_ROOT}/_out"
WORK="$(mktemp -d "${REPO_ROOT}/_out/.release.XXXXXX")"
trap 'rm -rf "${WORK}"' EXIT
case "${cmd}" in
plan) [ "$#" -eq 1 ] || die "usage: plan <scope>.<YYYYMMDD-HHMM>"; tag_parts "$1"; plan ;;
collect) [ "$#" -eq 4 ] || die "usage: collect <product> <scope>.<YYYYMMDD-HHMM> <plan> <dir>"; tag_parts "$2"; collect "$1" "$3" "$4" ;;
publish) [ "$#" -eq 2 ] || die "usage: publish <scope>.<YYYYMMDD-HHMM> <dir>"; tag_parts "$1"; publish "$2" ;;
attach) [ "$#" -eq 2 ] || die "usage: attach <scope>.<YYYYMMDD-HHMM> <dir>"; tag_parts "$1"; attach "$2" ;;
index) [ "$#" -le 2 ] || die "usage: index [--dry-run] [<scope>.<YYYYMMDD-HHMM>]"; index "$@" ;;
verify-index) { [ "$#" -eq 1 ] || { [ "$#" -eq 2 ] && [ "$2" = --full ]; }; } || die "usage: verify-index mica.<YYYYMMDD-HHMM> [--full]"; verify_index "$@" ;;
*) die "usage: bash tools/release.sh plan|collect|publish|attach|index ..." ;;
esac
