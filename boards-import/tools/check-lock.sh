#!/usr/bin/env bash
# Check files against the file rules of mica-lock v1 and mica-pin v1
# (mica:docs/design/release-lock.md) and print `valid`, or `refused <rule>` and
# exit 1 at the first rule broken.
#
#   bash tools/check-lock.sh lock <file>             a release lock (1.1 to 1.5)
#   bash tools/check-lock.sh upstream <file>         locks/upstream.lock (4.1)
#   bash tools/check-lock.sh pins <dir> ci|local     <dir>/*.lock and <dir>/pins/*.pin (4)
#   bash tools/check-lock.sh vectors-pin <file>      tools/vectors.pin (mica-vectors-pin v1)
#
# tools/locks.sh runs it over locks/, tools/release-lock.sh over the
# lock it writes, tests/locks-test.sh over the specification's vectors.
# Registry checks are not file rules.
set -euo pipefail
export LC_ALL=C

usage() { echo "usage: bash tools/check-lock.sh lock|upstream|vectors-pin <file> | pins <dir> ci|local" >&2; exit 2; }
refuse() { echo "refused $1"; exit 1; }

# The repositories whose releases are scoped (<scope>.<YYYYMMDD-HHMM>): all of theirs, no other's.
SCOPED_REPOSITORIES=" mica-boards mica-build "

# mica-vectors-pin v1: the commit of the repository this repository's lock
# vectors were taken from. Exactly two keys in this order and no others -- a
# RELEASE= key here would make it look like a producer pin, and mica publishes
# no releases. The BASENAME vectors.pin is uniform across repositories on
# purpose: it turns "find every reader's copy" into one command.
if [ "${1-}" = vectors-pin ]; then
    [ "$#" -eq 2 ] || usage
    FILE="$2"
    [ -f "${FILE}" ] || { echo "error: ${FILE} is not a file" >&2; exit 2; }
    iconv -f UTF-8 -t UTF-8 "${FILE}" >/dev/null 2>&1 || refuse encoding
    [ -s "${FILE}" ] && [ "$(tail -c1 "${FILE}" | od -An -tx1 | tr -d ' ')" = 0a ] || refuse encoding
    [ "$(tr -dc '' <"${FILE}" | wc -c)" = 0 ] || refuse encoding
    mapfile -t PLINES <"${FILE}"
    [ "${PLINES[0]-}" = '# mica-vectors-pin v1' ] || refuse header
    PKEYS=()
    for line in ${PLINES[@]+"${PLINES[@]:1}"}; do
        case "${line}" in '#'*) continue ;; esac
        [ -n "${line}" ] || refuse encoding
        PKEYS+=("${line}")
    done
    [ "${#PKEYS[@]}" = 2 ] || refuse pin-format
    [ "${PKEYS[0]%%=*}" = REPOSITORY ] && [ "${PKEYS[1]%%=*}" = COMMIT ] || refuse pin-format
    [[ "${PKEYS[0]#*=}" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [[ "${PKEYS[1]#*=}" =~ ^[0-9a-f]{40}$ ]] || refuse field-value
    echo valid
    exit 0
fi

# 4: every producer lock has one pin naming it and its release; upstream.lock has none.
# A scoped input is locks/<repository>.<scope>.lock with pins/<repository>.<scope>.pin.
if [ "${1-}" = pins ]; then
    [ "$#" -eq 3 ] && { [ "$3" = ci ] || [ "$3" = local ]; } || usage
    DIR="$2" MODE="$3"
    [ -d "${DIR}/pins" ] || { echo "error: ${DIR}/pins is not a directory" >&2; exit 2; }
    declare -A PIN_REPOSITORY=() PIN_SCOPE=() PIN_RELEASE=() PIN_CHECKOUT=()
    mapfile -t PINS < <(find "${DIR}/pins" -maxdepth 1 -type f -name '*.pin' -printf '%f\n' | sed 's/\.pin$//' | sort)
    mapfile -t LOCKS < <(find "${DIR}" -maxdepth 1 -type f -name '*.lock' ! -name upstream.lock -printf '%f\n' | sed 's/\.lock$//' | sort)
    for name in ${PINS[@]+"${PINS[@]}"}; do
        pin="${DIR}/pins/${name}.pin"
        iconv -f UTF-8 -t UTF-8 "${pin}" >/dev/null 2>&1 || refuse encoding
        [ -s "${pin}" ] && [ "$(tail -c1 "${pin}" | od -An -tx1 | tr -d ' ')" = 0a ] || refuse encoding
        [ "$(tr -dc '\r' <"${pin}" | wc -c)" = 0 ] || refuse encoding
        mapfile -t LINES <"${pin}"
        [ "${LINES[0]}" = "# mica-pin v1" ] || refuse header
        KEYS_SEEN=""
        declare -A VALUES=()
        for line in "${LINES[@]:1}"; do
            key="${line%%=*}"
            [ "${key}" != "${line}" ] || refuse pin-format
            KEYS_SEEN="${KEYS_SEEN} ${key}"
            VALUES["${key}"]="${line#*=}"
        done
        release="${VALUES[RELEASE]-}"
        want=" REPOSITORY"
        [ -z "${VALUES[SCOPE]+x}" ] || want="${want} SCOPE"
        want="${want} RELEASE SHA256SUMS"
        [ "${release}" != offline ] || want="${want} CHECKOUT"
        [ "${KEYS_SEEN}" = "${want}" ] || refuse pin-format
        [[ "${VALUES[REPOSITORY]}" =~ ^[a-z0-9][a-z0-9-]*$ ]] && [[ "${VALUES[SHA256SUMS]}" =~ ^[0-9a-f]{64}$ ]] &&
            { [ "${release}" = offline ] || [[ "${release}" =~ ^[0-9]{8}-[0-9]{4}$ ]]; } &&
            { [ -z "${VALUES[SCOPE]+x}" ] || [[ "${VALUES[SCOPE]}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; } || refuse field-value
        [ "${release}" != offline ] || [[ "${VALUES[CHECKOUT]}" == /* ]] || refuse field-value
        file_repository="${name%%.*}"
        file_scope=""
        [ "${name}" = "${file_repository}" ] || file_scope="${name#*.}"
        [ "${VALUES[REPOSITORY]}" = "${file_repository}" ] || refuse name-mismatch
        [ "${VALUES[SCOPE]-}" = "${file_scope}" ] || refuse scope-mismatch
        case "${SCOPED_REPOSITORIES}" in *" ${file_repository} "*) scoped=1 ;; *) scoped=0 ;; esac
        { [ -n "${VALUES[SCOPE]+x}" ] && [ "${scoped}" = 1 ]; } || { [ -z "${VALUES[SCOPE]+x}" ] && [ "${scoped}" = 0 ]; } || refuse release-scope
        PIN_REPOSITORY["${name}"]="${VALUES[REPOSITORY]}"
        PIN_SCOPE["${name}"]="${VALUES[SCOPE]-}"
        PIN_RELEASE["${name}"]="${release}"
        PIN_CHECKOUT["${name}"]="${VALUES[CHECKOUT]-}"
        unset VALUES
    done
    for name in ${PINS[@]+"${PINS[@]}"}; do [ -f "${DIR}/${name}.lock" ] || refuse pin-without-lock; done
    for name in ${LOCKS[@]+"${LOCKS[@]}"}; do [ -n "${PIN_RELEASE[${name}]-}" ] || refuse lock-without-pin; done
    for name in ${PINS[@]+"${PINS[@]}"}; do
        lock="${DIR}/${name}.lock"
        bash "${BASH_SOURCE[0]}" lock "${lock}" >/dev/null 2>&1 || refuse lock-invalid
        IFS=$'\t' read -r _kind lock_repository lock_release _commit < <(grep -m1 '^release'$'\t' "${lock}")
        lock_scope=""
        case "${lock_release}" in *.*) lock_scope="${lock_release%.*}"; lock_release="${lock_release##*.}" ;; esac
        [ "${lock_repository}" = "${PIN_REPOSITORY[${name}]}" ] || refuse lock-invalid
        [ "${lock_scope}" = "${PIN_SCOPE[${name}]}" ] || refuse scope-mismatch
        [ "${lock_release}" = "${PIN_RELEASE[${name}]}" ] || refuse release-mismatch
        [ -z "${PIN_CHECKOUT[${name}]}" ] || [ "${MODE}" != ci ] || refuse checkout-in-ci
    done
    echo valid
    exit 0
fi

[ "$#" -eq 2 ] && { [ "$1" = lock ] || [ "$1" = upstream ]; } || usage
MODE="$1"
FILE="$2"
[ -f "${FILE}" ] || { echo "error: ${FILE} is not a file" >&2; exit 2; }

KINDS=(release image pool package board upstream apt data)
declare -A COLUMNS=([release]=4 [image]=5 [pool]=3 [package]=5 [board]=5 [upstream]=7 [apt]=5 [data]=4)
kind_index() { local i; for i in "${!KINDS[@]}"; do [ "${KINDS[$i]}" != "$1" ] || { echo "$i"; return; }; done; }

# 1.1: UTF-8, LF with a final LF, no CR, header, no empty line, leading space or trailing tab.
iconv -f UTF-8 -t UTF-8 "${FILE}" >/dev/null 2>&1 || refuse encoding
[ -s "${FILE}" ] && [ "$(tail -c1 "${FILE}" | od -An -tx1 | tr -d ' ')" = 0a ] || refuse encoding
[ "$(tr -dc '\r' <"${FILE}" | wc -c)" = 0 ] || refuse encoding
mapfile -t LINES <"${FILE}"
[ "${LINES[0]}" = "# mica-lock v1" ] || refuse header

ROWS=()
for line in "${LINES[@]:1}"; do
    [ -n "${line}" ] || refuse encoding
    case "${line}" in ' '*) refuse encoding ;; *$'\t') refuse encoding ;; '#'*) continue ;; esac
    ROWS+=("${line}")
done

# split <row>: FIELDS, split on every tab (empty fields kept).
split() {
    local rest="$1"
    FIELDS=()
    while [[ "${rest}" == *$'\t'* ]]; do
        FIELDS+=("${rest%%$'\t'*}")
        rest="${rest#*$'\t'}"
    done
    FIELDS+=("${rest}")
}

NAME_RE='^[a-z0-9][a-z0-9.+-]*$'
# An upstream image keeps its original name and reference, as debian:trixie-slim.
UPSTREAM_NAME_RE='^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?$'
UPSTREAM_REFERENCE_RE='^[a-z0-9-]+(\.[a-z0-9-]+)+(:[0-9]+)?/[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$'
REPOSITORY_RE='^[a-z0-9][a-z0-9-]*$'
VERSION_RE='^[A-Za-z0-9.+~:-]+$'
SHA_RE='^[0-9a-f]{64}$'
ARCH_RE='^(amd64|arm64)$'

# upstream_image: the fields of an `image upstream` row in FIELDS; an upstream
# image by digest, never republished on one of Mica's own registries.
upstream_image() {
    [[ "${FIELDS[2]}" =~ ${UPSTREAM_NAME_RE} ]] && [[ "${FIELDS[3]}" =~ ^(index|amd64|arm64|386)$ ]] || refuse field-value
    [[ "${FIELDS[4]}" == *@sha256:* ]] || refuse reference-digest
    case "${FIELDS[4]}" in ghcr.io/micaoss/* | local/*) refuse reference-upstream ;; esac
    [[ "${FIELDS[4]}" =~ ${UPSTREAM_REFERENCE_RE} ]] || refuse field-value
}

# 4.1: no release row; image, source and git rows only.
if [ "${MODE}" = upstream ]; then
    declare -A UCOLUMNS=([image]=5 [source]=6 [git]=5)
    UKINDS=(image source git)
    for row in ${ROWS[@]+"${ROWS[@]}"}; do
        split "${row}"
        [ "${FIELDS[0]}" != release ] || refuse upstream-release-row
        [ -n "${UCOLUMNS[${FIELDS[0]}]-}" ] || refuse kind-unknown
        [ "${#FIELDS[@]}" = "${UCOLUMNS[${FIELDS[0]}]}" ] || refuse column-count
    done
    declare -A KEYS=()
    SORTKEYS=()
    for row in ${ROWS[@]+"${ROWS[@]}"}; do
        split "${row}"
        kind="${FIELDS[0]}"
        case "${kind}" in
        image)
            [ "${FIELDS[1]}" = upstream ] || refuse image-source
            upstream_image
            key="${FIELDS[1]}"$'\x01'"${FIELDS[2]}"$'\x01'"${FIELDS[3]}"
            ;;
        source)
            [[ "${FIELDS[1]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[2]}" =~ ^(amd64|arm64|all)$ ]] && [[ "${FIELDS[3]}" =~ ${VERSION_RE} ]] &&
                [[ "${FIELDS[4]}" =~ ${SHA_RE} ]] && [[ "${FIELDS[5]}" == https://* ]] || refuse field-value
            key="${FIELDS[1]}"$'\x01'"${FIELDS[2]}"
            ;;
        git)
            [[ "${FIELDS[1]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[2]}" == https://* ]] && [ -n "${FIELDS[3]}" ] && [[ "${FIELDS[4]}" =~ ^[0-9a-f]{40}$ ]] || refuse field-value
            key="${FIELDS[1]}"
            ;;
        esac
        [ -z "${KEYS[${kind}$'\x02'${key}]-}" ] || refuse duplicate-key
        KEYS["${kind}"$'\x02'"${key}"]=1
        for i in "${!UKINDS[@]}"; do [ "${UKINDS[$i]}" != "${kind}" ] || SORTKEYS+=("${i}"$'\x01'"${key}"); done
    done
    for ((i = 1; i < ${#SORTKEYS[@]}; i++)); do
        [[ ! "${SORTKEYS[$((i - 1))]}" > "${SORTKEYS[$i]}" ]] || refuse sort-order
    done
    echo valid
    exit 0
fi

for row in ${ROWS[@]+"${ROWS[@]}"}; do
    split "${row}"
    [ -n "${COLUMNS[${FIELDS[0]}]-}" ] || refuse kind-unknown
    [ "${#FIELDS[@]}" = "${COLUMNS[${FIELDS[0]}]}" ] || refuse column-count
done

releases=0
for row in ${ROWS[@]+"${ROWS[@]}"}; do [ "${row%%$'\t'*}" != release ] || releases=$((releases + 1)); done
[ "${#ROWS[@]}" -gt 0 ] && [ "${ROWS[0]%%$'\t'*}" = release ] && [ "${releases}" = 1 ] || refuse release-row

split "${ROWS[0]}"
REPOSITORY="${FIELDS[1]}" RELEASE="${FIELDS[2]}" SCOPE=""
# A scoped repository's release is <scope>.<YYYYMMDD-HHMM> (or <scope>.offline), split
# at its last dot: a scope carries no dot, and a slash leaves the release out of
# form, which is refused as field-value (mica:docs/design/release-lock.md 1.0).
case "${RELEASE}" in *.*) SCOPE="${RELEASE%.*}"; RELEASE="${RELEASE##*.}" ;; esac
[[ "${REPOSITORY}" =~ ^[a-z0-9][a-z0-9-]*$ ]] && { [[ "${RELEASE}" =~ ^[0-9]{8}-[0-9]{4}$ ]] || [ "${RELEASE}" = offline ]; } &&
    [[ "${FIELDS[3]}" =~ ^[0-9a-f]{40}$ ]] && { [ -z "${SCOPE}" ] || [[ "${SCOPE}" =~ ^[a-z0-9][a-z0-9-]*$ ]]; } || refuse field-value
case "${SCOPED_REPOSITORIES}" in *" ${REPOSITORY} "*) [ -n "${SCOPE}" ] || refuse release-scope ;; *) [ -z "${SCOPE}" ] || refuse release-scope ;; esac
# A board release holds only its board: its pool tags and its board row name the scope.
BOARD_SCOPE=""
[ "${REPOSITORY}" != mica-boards ] || BOARD_SCOPE="${SCOPE}"
REGISTRY=ghcr.io/micaoss
[ "${RELEASE}" != offline ] || REGISTRY=local

# reference <ref> [<repository>]: a reference to <repository> (default the release's) by digest.
reference() {
    [[ "$1" == *@sha256:* ]] || refuse reference-digest
    [[ "$1" =~ ^(ghcr\.io/micaoss|local)/([a-z0-9][a-z0-9-]*)(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || {
        case "$1" in ghcr.io/micaoss/* | local/*) refuse field-value ;; esac
        refuse reference-registry
    }
    [ "${BASH_REMATCH[1]}" = "${REGISTRY}" ] || refuse reference-registry
    [ "${BASH_REMATCH[2]}" = "${2:-${REPOSITORY}}" ] || refuse reference-repository
    TAG="${BASH_REMATCH[3]#:}"
}

declare -A KEYS=() POOLS=() DATA_FILES=()
SORTKEYS=() PACKAGE_ARCHES=() BASE_ONLY=0 BOARD_COMPONENTS=""
for row in "${ROWS[@]:1}"; do
    split "${row}"
    kind="${FIELDS[0]}"
    case "${kind}" in
    image)
        if [ "${FIELDS[1]}" = upstream ]; then
            upstream_image
        elif [[ "${FIELDS[1]}" =~ ${REPOSITORY_RE} ]]; then
            [[ "${FIELDS[2]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[3]}" =~ ^(index|amd64|arm64|386)$ ]] || refuse field-value
            reference "${FIELDS[4]}" "${FIELDS[1]}"
            # A producer's own lock names only its own images besides upstream ones.
            [ "${FIELDS[1]}" = "${REPOSITORY}" ] || refuse image-source
        else
            refuse image-source
        fi
        key="${FIELDS[1]}"$'\x01'"${FIELDS[2]}"$'\x01'"${FIELDS[3]}"
        ;;
    pool)
        [[ "${FIELDS[1]}" =~ ${ARCH_RE} ]] || refuse field-value
        reference "${FIELDS[2]}"
        [ -z "${BOARD_SCOPE}" ] || [[ "${TAG}" == "pool.${BOARD_SCOPE}.${FIELDS[1]}."* ]] || refuse scope-content
        key="${FIELDS[1]}"
        POOLS["${FIELDS[1]}"]=1
        ;;
    package)
        [[ "${FIELDS[1]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[2]}" =~ ${ARCH_RE} ]] && [[ "${FIELDS[3]}" =~ ${VERSION_RE} ]] && [[ "${FIELDS[4]}" =~ ${SHA_RE} ]] || refuse field-value
        key="${FIELDS[1]}"$'\x01'"${FIELDS[2]}"
        PACKAGE_ARCHES+=("${FIELDS[2]}")
        ;;
    board)
        # board <board> <component> <arch> <reference>: one row per component artifact of a board.
        [[ "${FIELDS[1]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[2]}" =~ ^(board|kernel|uboot|firmware)$ ]] && [[ "${FIELDS[3]}" =~ ${ARCH_RE} ]] || refuse field-value
        reference "${FIELDS[4]}"
        [ -z "${BOARD_SCOPE}" ] || { [ "${FIELDS[1]}" = "${BOARD_SCOPE}" ] && [[ "${TAG}" == "${FIELDS[2]}.${FIELDS[1]}."* ]]; } || refuse scope-content
        BOARD_COMPONENTS="${BOARD_COMPONENTS} ${FIELDS[2]}"
        key="${FIELDS[1]}"$'\x01'"${FIELDS[2]}"
        ;;
    upstream)
        roots="${FIELDS[6]}"
        sorted="$(tr ',' '\n' <<<"${roots}" | sort -u | paste -sd, -)"
        ok=1
        for r in ${roots//,/ }; do [[ "${r}" =~ ${NAME_RE} ]] || ok=0; done
        [[ "${FIELDS[1]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[2]}" =~ ${ARCH_RE} ]] && [[ "${FIELDS[3]}" =~ ${VERSION_RE} ]] &&
            [[ "${FIELDS[4]}" =~ ${SHA_RE} ]] && [[ "${FIELDS[5]}" == https://* ]] && [ "${ok}" = 1 ] && [ "${sorted}" = "${roots}" ] || refuse field-value
        key="${FIELDS[1]}"$'\x01'"${FIELDS[2]}"
        BASE_ONLY=1
        ;;
    apt)
        [[ "${FIELDS[1]}" == https://* ]] && [ -n "${FIELDS[2]}" ] && [ -n "${FIELDS[3]}" ] && [[ "${FIELDS[4]}" == /* ]] || refuse field-value
        key=""
        BASE_ONLY=1
        ;;
    data)
        # data <name> <file> <sha256> (1.2.4): a release asset that is neither
        # an image nor a package -- something a producer computed about its own
        # output that a consumer must be able to read reproducibly from a
        # pinned release. NOT base-only: mica-system-base is the only producer
        # carrying one today, and a lock this repository PINS may grow one
        # tomorrow. The name is the key; two rows may not name one FILE either,
        # which is a separate rule from the duplicate key and is what
        # data-file refuses.
        [[ "${FIELDS[1]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[2]}" =~ ${NAME_RE} ]] && [[ "${FIELDS[3]}" =~ ${SHA_RE} ]] || refuse field-value
        [ -z "${DATA_FILES[${FIELDS[2]}]-}" ] || refuse data-file
        DATA_FILES["${FIELDS[2]}"]=1
        key="${FIELDS[1]}"
        ;;
    *) refuse release-row ;;
    esac
    [ -z "${KEYS[${kind}$'\x02'${key}]-}" ] || refuse duplicate-key
    KEYS["${kind}"$'\x02'"${key}"]=1
    SORTKEYS+=("$(kind_index "${kind}")"$'\x01'"${key}")
done

[ "${REPOSITORY}" = mica-system-base ] || [ "${BASE_ONLY}" = 0 ] || refuse base-only-kind
for a in ${PACKAGE_ARCHES[@]+"${PACKAGE_ARCHES[@]}"}; do [ -n "${POOLS[${a}]-}" ] || refuse package-without-pool; done
# A mica-boards lock names at least the board's board and kernel components.
if [ "${REPOSITORY}" = mica-boards ]; then
    case "${BOARD_COMPONENTS} " in *" board "*) ;; *) refuse board-components ;; esac
    case "${BOARD_COMPONENTS} " in *" kernel "*) ;; *) refuse board-components ;; esac
fi
for ((i = 1; i < ${#SORTKEYS[@]}; i++)); do
    [[ ! "${SORTKEYS[$((i - 1))]}" > "${SORTKEYS[$i]}" ]] || refuse sort-order
done
echo valid
