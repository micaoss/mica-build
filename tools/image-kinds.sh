#!/usr/bin/env bash
# The image kinds of a product: one packer per kind, dispatched here.
#
#   bash tools/image-kinds.sh check <kind>...
#       every kind has a packer; a reserved kind or an unknown one is refused, before anything is built
#   bash tools/image-kinds.sh pack <product out> <kind>...
#       runs tools/image-kinds/<kind>.sh <product out> for each kind and writes <product out>/kinds.tsv:
#       one row per output, <kind> TAB <file relative to the product out>, the release assets of that kind
#
# A board declares the kinds it can be flashed as in board.env IMAGE_KINDS and
# delivers their board-level pieces in its uboot component; a product selects a
# subset (tools/product.sh), and the whole-disk flashing formats are built here,
# per product (user decision 2026-09-15). A packer reads the product's built
# components under <product out> and prints the files it produced, one per line,
# relative to <product out>; adding a kind adds its packer module and its
# verification, nothing else.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "image-kinds.sh: error: $*" >&2; exit 1; }

# The kinds a board may declare that no packer builds yet, and where each is planned.
reserved() { # <kind>: prints the reason, or fails
    case "$1" in
    rockchip-update) echo "a Rockchip update.img, planned in mica:docs/plan/20260912-2253-rockchip-update-image.md and not resumed" ;;
    amlogic-burn) echo "an Amlogic burn package, reserved with no plan yet (the board delivers its uboot-package/ pieces)" ;;
    *) return 1 ;;
    esac
}

check() { # <kind>
    [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "'$1' is not an image kind name"
    [ ! -f "${HERE}/image-kinds/$1.sh" ] || return 0
    local why
    why="$(reserved "$1")" && die "the image kind '$1' is ${why}; it is not produced yet"
    die "the image kind '$1' is unknown; the kinds produced are: $(cd "${HERE}/image-kinds" && ls -1 *.sh | sed 's/\.sh$//' | tr '\n' ' ')"
}

cmd="${1:-}"; [ "$#" -eq 0 ] || shift
case "${cmd}" in
check)
    [ "$#" -gt 0 ] || die "check names no image kind"
    for kind in "$@"; do check "${kind}"; done
    ;;
pack)
    out="${1:-}"; [ "$#" -eq 0 ] || shift
    [ -d "${out}" ] && [ "$#" -gt 0 ] || die "usage: bash tools/image-kinds.sh pack <product out> <kind>..."
    for kind in "$@"; do check "${kind}"; done
    : >"${out}/kinds.tsv.part"
    for kind in "$@"; do
        files="$(bash "${HERE}/image-kinds/${kind}.sh" "${out}")" || die "the ${kind} packer failed (see above)"
        [ -n "${files}" ] || die "the ${kind} packer produced no file"
        while IFS= read -r f; do
            [[ "${f}" != /* && "${f}" != *..* ]] && [ -f "${out}/${f}" ] || die "the ${kind} packer names ${f}, which is not a file under ${out}"
            printf '%s\t%s\n' "${kind}" "${f}" >>"${out}/kinds.tsv.part"
        done <<<"${files}"
    done
    mv "${out}/kinds.tsv.part" "${out}/kinds.tsv"
    echo "image-kinds.sh: $(cut -f1 "${out}/kinds.tsv" | sort -u | tr '\n' ' ')-> $(cut -f2 "${out}/kinds.tsv" | tr '\n' ' ')"
    ;;
*)
    die "usage: bash tools/image-kinds.sh check <kind>... | pack <product out> <kind>..."
    ;;
esac
