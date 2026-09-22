#!/usr/bin/env bash
# The package-set resolver: WHAT a build installs, from the build's inputs and
# the manifests beside this file.
#
#   bash rootfs/packages/resolve.sh --board cx3576 --board-dir _out/boards/cx3576/manifests \
#        --features "micad mqtt containers wifi bluetooth"
#   -> mica-apid
#      mica-board-cx3576
#      mica-bluetooth
#      ...
#
# One package name per line on stdout, LC_ALL=C sorted and deduplicated, and
# nothing else: two runs over one set of inputs are byte-identical, so a diff of
# two resolutions is a diff of the images they compose. Every refusal goes to
# stderr and exits non-zero.
#
# The engine's manifests (common, feature-*, radio-*) are read from
# THIS directory; the board's (board.pkgs, radio-<r>.pkgs, component-<c>.pkgs)
# from --board-dir, the manifests/ of the fetched board bundle
# (tools/board-pool.sh --fetch): what a board installs travels with the
# board. The package set is read at run time from `bash bin/bun.sh src/cli.ts pool rows` --
# the only authority on which packages exist -- in the repository this
# directory sits in, located by walking up to the Makefile rather than by
# counting `..` levels. That is what lets a COPY of this directory anywhere
# under the repository resolve against the same pins, which is how
# tests/gates/rootfs-manifest-test.sh proves its negative tests red: it perturbs a
# copy of the manifests instead of the tracked ones.
#
# The image profile selects no package: dev and prod install the same set.
#
# The manifest format is documented in rootfs/packages/README.md.
set -euo pipefail

# Sorting, globbing and the byte order of the output all have to agree with the
# one the composer and every diff of two resolutions will see.
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${HERE}"
while [ "${REPO_ROOT}" != "/" ] && [ ! -f "${REPO_ROOT}/Makefile" ]; do
    REPO_ROOT="$(dirname "${REPO_ROOT}")"
done
[ -f "${REPO_ROOT}/Makefile" ] || {
    echo "error: no Makefile was found in any directory above ${HERE}, so this is not a copy of rootfs/packages inside the mica repository. The repository root is where \`bash bin/bun.sh src/cli.ts pool rows\` -- the list of packages a manifest may name -- is read from" >&2
    exit 1
}

usage() {
    echo "usage: bash rootfs/packages/resolve.sh --board <board> --board-dir <manifests dir> --features \"<features>\" [--components \"<components>\"]" >&2
}

in_list() {
    local needle="$1"
    shift
    local item
    for item in "$@"; do [ "${item}" != "${needle}" ] || return 0; done
    return 1
}

# EVERY INPUT IS AN ARGUMENT, AND NONE OF THEM IS RE-DERIVED HERE. This script
# does not read _out/boards/<board>/board.env or WITH_MICAD/WITH_CONTAINERS/MICA_ROOTFS_WITHOUT out of the
# environment, and it must not learn to: rootfs/build.sh already owns
# every one of those decisions -- which board file is read, which environment
# variable beats which file, how the historical WITH_* spellings fold into the
# decline list. A second copy of that logic here is the second table this
# repository keeps deleting, and the two would disagree about a build the day
# either changed. The driver owns the DECISIONS; this script owns the MANIFEST
# SET and nothing else.
#
# All four are required even when empty, and --radios "" and --without "" are
# how a caller says "none". Making them optional would mean a driver that forgot
# to pass --radios silently produced an image with no radio userland on a board
# that has a radio -- a build that succeeds and a device that cannot see a
# network.
BOARD=""
BOARD_DIR=""
FEATURES=""
COMPONENTS=""
HAVE_BOARD=0
HAVE_FEATURES=0
while [ "$#" -gt 0 ]; do
    case "$1" in
    --board)
        BOARD="${2-}"
        HAVE_BOARD=1
        shift 2
        ;;
    --board-dir)
        BOARD_DIR="${2-}"
        shift 2
        ;;
    --features)
        FEATURES="${2-}"
        HAVE_FEATURES=1
        shift 2
        ;;
    --components)
        [ "$#" -ge 2 ] || { echo 'error: --components needs a value' >&2; exit 1; }
        COMPONENTS=$2
        shift 2
        ;;
    *)
        echo "error: unknown argument '$1'" >&2
        usage
        exit 1
        ;;
    esac
done
# FEATURES ARE OPT-IN. A product names what it wants (tools/product.sh
# validates that against the board's BOARD_FEATURES before this script
# runs); --features "" is the minimal image, the floor and the board
# package. The argument is required even when empty, so a driver that
# forgot to pass it cannot silently compose the minimal image where a full
# one was meant.
[ -n "${BOARD_DIR}" ] || { echo "error: --board-dir was not given. The board's own manifests (board.pkgs, radio-<r>.pkgs, component-<c>.pkgs) are read out of the fetched board bundle, _out/boards/<board>/manifests; run \`make board-fetch BOARD=<board>\`" >&2; usage; exit 1; }
[ -d "${BOARD_DIR}" ] || { echo "error: --board-dir ${BOARD_DIR} is not a directory; the board bundle is not fetched (make board-fetch BOARD=${BOARD:-<board>})" >&2; exit 1; }
for pair in "board:${HAVE_BOARD}" "features:${HAVE_FEATURES}"; do
    [ "${pair#*:}" = "1" ] || {
        echo "error: --${pair%%:*} was not given. Both are required; --features \"\" is how the minimal image says so, because an omitted one would resolve to a package set nothing had decided" >&2
        usage
        exit 1
    }
done

# The manifests, discovered rather than listed: a manifest added to this
# directory is in the resolution the day it lands, and one this script had to be
# taught about would be one it could silently omit.
shopt -s nullglob
MANIFEST_FILES=("${HERE}"/*.pkgs)
shopt -u nullglob
[ "${#MANIFEST_FILES[@]}" -gt 0 ] || {
    echo "error: ${HERE} holds no *.pkgs manifest at all. Every resolution would then be empty, and a resolver with nothing to resolve reports the empty set rather than reporting this" >&2
    exit 1
}

# The packages that exist: the package rows of locks/ (src/cli.ts pool rows,
# read through it rather than restated) and the packages this tree's own
# producers declare (tools/deb/producers.sh: the board and radio packages,
# built by make board-pool). A manifest naming anything else is a line the
# composition would fail on, where the message is about an unsatisfiable
# package rather than about the manifest that named it. Captured before it is
# read: a lock that refuses its own rows must stop this resolution.
declare -A DECLARED=()
DECLARED_N=0
LOCK_ROWS="$(bash "${REPO_ROOT}/bin/bun.sh" src/cli.ts pool rows)"
while IFS=$'\t' read -r pkg _rest; do
    [ -n "${pkg}" ] || continue
    [ -n "${DECLARED[${pkg}]:-}" ] || DECLARED_N=$((DECLARED_N + 1))
    DECLARED["${pkg}"]=1
done <<<"${LOCK_ROWS}"
OWN_ROWS="$(bash "${REPO_ROOT}/tools/deb/producers.sh")"
while read -r _producer _dir _arches packages _enablement; do
    [ -n "${packages}" ] || continue
    for pkg in ${packages//,/ }; do
        [ -n "${DECLARED[${pkg}]:-}" ] || DECLARED_N=$((DECLARED_N + 1))
        DECLARED["${pkg}"]=1
    done
done <<<"${OWN_ROWS}"
[ "${DECLARED_N}" -gt 0 ] || {
    echo "error: locks/ named no package and no producer declares one. The cross-check below would then accept every manifest line, having compared each against an empty set" >&2
    exit 1
}

# Every manifest in the directory is parsed and cross-checked on EVERY run, not
# just the handful this resolution reads. A typo in the manifest of the other
# board is a typo that fails one board's build and not the other's, and the run
# that would have caught it is the run nobody makes.
declare -A MANIFEST=()
KNOWN_RADIOS=()
KNOWN_FEATURES=()
BOARD_RADIO_MANIFESTS=()
BOARD_COMPONENT_MANIFESTS=()
shopt -s nullglob
BOARD_MANIFEST_FILES=("${BOARD_DIR}"/*.pkgs)
shopt -u nullglob
# read_manifest <file> <key>: one package per line, every one declared.
read_manifest() {
    local file="$1" key="$2" names="" lineno=0 line
    while IFS= read -r line || [ -n "${line}" ]; do
        lineno=$((lineno + 1))
        line="${line%%#*}"
        # shellcheck disable=SC2086 # deliberate: the split is how a line
        # carrying more than one name is detected.
        set -- ${line}
        [ "$#" -gt 0 ] || continue
        [ "$#" -eq 1 ] || {
            echo "error: ${file}:${lineno} names $# packages on one line. A manifest holds ONE package name per line, so that a line can be added, removed or blamed on its own; see rootfs/packages/README.md" >&2
            exit 1
        }
        [ -n "${DECLARED[$1]:-}" ] || {
            echo "error: ${file}:${lineno} names the package '$1', which no package row of locks/ imports and no producer of this tree declares. A manifest may only name a pinned or an own package; \`bash bin/bun.sh src/cli.ts pool rows\` and \`bash tools/deb/producers.sh\` list them, and the packages that exist are: $(printf '%s\n' "${!DECLARED[@]}" | sort | tr '\n' ' ')" >&2
            exit 1
        }
        names="${names}$1 "
    done <"${file}"
    MANIFEST["${key}"]="${names}"
}
for file in "${MANIFEST_FILES[@]}"; do
    base="$(basename "${file}" .pkgs)"
    read_manifest "${file}" "${base}"

    # The family is the filename's prefix, and an unrecognised one is refused
    # rather than ignored: a manifest nothing selects is a package set that
    # never reaches an image and never fails a build either.
    case "${base}" in
    common) ;;
    radio-*) KNOWN_RADIOS+=("${base#radio-}") ;;
    feature-*) KNOWN_FEATURES+=("${base#feature-}") ;;
    board-* | component-*)
        echo "error: ${file} is a board manifest in the engine's directory. A board's manifests (board.pkgs, radio-<r>.pkgs, component-<c>.pkgs) live in the board repository under <board>/manifests/ and arrive here in the board bundle; nothing selects this file, so it would never be read into a resolution" >&2
        exit 1
        ;;
    *)
        echo "error: ${file} belongs to no manifest family. An engine manifest is named common.pkgs, radio-<radio>.pkgs or feature-<feature>.pkgs; nothing selects any other name, so this file would never be read into a resolution" >&2
        exit 1
        ;;
    esac
done

# THE BOARD'S MANIFESTS, out of its bundle: board.pkgs is the board, a
# radio-<r>.pkgs adds the board's transport packages to a radio the engine
# knows, a component-<c>.pkgs is an optional component a build names. Every
# file is parsed and cross-checked whether or not this resolution reads it.
[ -f "${BOARD_DIR}/board.pkgs" ] || {
    echo "error: ${BOARD_DIR} holds no board.pkgs. The board bundle carries the board's package manifest (mica:docs/boards/contract.md section 3); a board with none composes a root with no board package, which cannot boot" >&2
    exit 1
}
for file in ${BOARD_MANIFEST_FILES[@]+"${BOARD_MANIFEST_FILES[@]}"}; do
    base="$(basename "${file}" .pkgs)"
    case "${base}" in
    board) read_manifest "${file}" "board" ;;
    radio-*)
        radio="${base#radio-}"
        in_list "${radio}" ${KNOWN_RADIOS[@]+"${KNOWN_RADIOS[@]}"} || { echo "error: ${file} names the radio '${radio}', for which ${HERE} holds no radio-${radio}.pkgs. The radios the engine knows are: ${KNOWN_RADIOS[*]-none}" >&2; exit 1; }
        read_manifest "${file}" "board-radio-${radio}"
        BOARD_RADIO_MANIFESTS+=("${radio}")
        ;;
    component-?*)
        read_manifest "${file}" "${base}"
        BOARD_COMPONENT_MANIFESTS+=("${base#component-}")
        ;;
    *)
        echo "error: ${file} belongs to no board manifest family (board.pkgs, radio-<radio>.pkgs, component-<component>.pkgs); nothing selects this name" >&2
        exit 1
        ;;
    esac
done

# A radio is a feature like any other in --features: `wifi` selects
# radio-wifi.pkgs and the board's radio-wifi.pkgs beside it. A radio and a
# feature sharing one name would make that token ambiguous, so the collision
# is refused here rather than resolved by precedence.
for radio in ${KNOWN_RADIOS[@]+"${KNOWN_RADIOS[@]}"}; do
    ! in_list "${radio}" ${KNOWN_FEATURES[@]+"${KNOWN_FEATURES[@]}"} || {
        echo "error: ${HERE} holds both feature-${radio}.pkgs and radio-${radio}.pkgs. The name is a --without token in both families, so declining '${radio}' would be ambiguous; one of the two manifests has to be renamed" >&2
        exit 1
    }
    KNOWN_FEATURES+=("${radio}")
done
mapfile -t KNOWN_FEATURES < <(printf '%s\n' "${KNOWN_FEATURES[@]}" | sort -u)

for feature in ${FEATURES}; do
    in_list "${feature}" ${KNOWN_FEATURES[@]+"${KNOWN_FEATURES[@]}"} || {
        echo "error: --features names '${feature}', which this repository has no such thing as. The features that exist are: ${KNOWN_FEATURES[*]}. They come from the feature-<name>.pkgs and radio-<name>.pkgs manifests in ${HERE}" >&2
        exit 1
    }
done
SELECTED=" ${FEATURES} "
selected() { case "${SELECTED}" in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

[ -n "${BOARD}" ] || { echo "error: --board is empty" >&2; exit 1; }
RESOLVED="${MANIFEST[common]:-}"
RESOLVED="${RESOLVED}${MANIFEST[board]:-}"
for radio in ${KNOWN_RADIOS[@]+"${KNOWN_RADIOS[@]}"}; do
    if selected "${radio}"; then
        RESOLVED="${RESOLVED}${MANIFEST[radio-${radio}]:-}${MANIFEST[board-radio-${radio}]:-}"
    fi
done

for component in $COMPONENTS; do
    key="component-${component}"
    [ -n "${MANIFEST[$key]+present}" ] || {
        echo "error: component '$component' is unavailable for board '$BOARD'; ${BOARD_DIR} holds: ${BOARD_COMPONENT_MANIFESTS[*]-none}" >&2
        exit 1
    }
    RESOLVED="${RESOLVED}${MANIFEST[$key]}"
done

for feature in "${KNOWN_FEATURES[@]}"; do
    # A radio token has no feature-<name>.pkgs; the loop above already read its
    # radio-<name>.pkgs.
    ! selected "${feature}" || RESOLVED="${RESOLVED}${MANIFEST[feature-${feature}]:-}"
done

# An empty resolution composes a root holding nothing but Debian, and every
# check downstream of it is a check over an image with no Mica OS in it.
RESOLVED_N=0
for pkg in ${RESOLVED}; do RESOLVED_N=$((RESOLVED_N + 1)); done
[ "${RESOLVED_N}" -gt 0 ] || {
    echo "error: the resolution for --board ${BOARD} is EMPTY. Every manifest it reads named nothing, so the composer would install no mica package at all and every check over the result would run against a plain Debian root" >&2
    exit 1
}

# A resolution with no board package has no kernel, no device tree and no
# rendered layout: it composes a root that cannot boot on anything.
BOARD_PACKAGES="${MANIFEST[board]:-}"
BOARD_IN_SET_N=0
for pkg in ${RESOLVED}; do
    in_list "${pkg}" ${BOARD_PACKAGES} && BOARD_IN_SET_N=$((BOARD_IN_SET_N + 1))
done
[ "${BOARD_IN_SET_N}" -gt 0 ] || {
    echo "error: the resolution for --board ${BOARD} carries NO board package. ${BOARD_DIR}/board.pkgs named none, so the image would have none of the layout files rendered from the board's board.env -- an artifact that composes and cannot boot" >&2
    exit 1
}

printf '%s\n' ${RESOLVED} | sort -u
