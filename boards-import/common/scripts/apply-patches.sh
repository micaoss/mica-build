#!/usr/bin/env bash
# mica-build-side: container -- it patches the vendor tree fetched into the BSP
# builder image; nothing in this repository's checkout is touched.
#
# Apply a patch series to a fetched source tree, in the order the series names.
#
#   apply-patches.sh /ksrc  /patches patch     (kernel: GNU patch -p1)
#   apply-patches.sh /uboot /patches git       (U-Boot: git apply)
#
# THE SERIES FILE IS THE LIST, and it replaced a `count=$(ls *.patch | wc -l)`
# assertion that pinned only the LENGTH. Three failures that count could not
# distinguish, and this can:
#
#   * a patch added to the directory and never applied -- the old check went red
#     only if someone also forgot to bump the number, so "add the patch, bump the
#     count" was a green way to ship an unapplied patch;
#   * a patch renamed, where the count still matches and the ORDER changes;
#   * an empty or missing directory, where `for p in $(ls ...)` iterated zero
#     times inside a command substitution and applied nothing, green.
#
# So all three are asserted: the series must be non-empty, every line of it must
# exist, and every *.patch in the directory must appear in it. The last one is
# what makes adding a patch file without listing it a failure rather than a
# no-op.
#
# THE APPLIER IS AN ARGUMENT rather than one tool for both trees. The kernel
# Dockerfile used GNU `patch -p1 --no-backup-if-mismatch` and the U-Boot one used
# `git apply -v`, and RFCT-345 kept each series on the tool it was written
# against rather than picking one. That is not a preference: `patch` applies with
# a default fuzz of 2 and `git apply` does not, so a series that lands with fuzz
# under one tool and is refused by the other -- or lands at a different offset --
# changes what is compiled, and this task's whole gate is that the artefacts do
# not change. Whether either series would also apply under the other tool was not
# measured; unifying them is a separate change with its own byte comparison.
set -euo pipefail

[ "$#" -eq 3 ] || {
    echo "usage: apply-patches.sh <source-tree> <patch-dir> <patch|git>" >&2
    exit 1
}
SRC="$1"
PATCHDIR="$2"
APPLIER="$3"
SERIES="${PATCHDIR}/series"

[ -d "${SRC}" ] || { echo "error: ${SRC} is not a directory; there is no tree to patch" >&2; exit 1; }
[ -f "${SERIES}" ] || {
    echo "error: ${SERIES} does not exist. The series is the list of patches to apply; without it this step would have nothing to iterate and would succeed having patched nothing" >&2
    exit 1
}

# Comments and blank lines, so the series can say why an entry is where it is.
mapfile -t SERIES_ENTRIES < <(sed -e 's/[[:space:]]*#.*$//' -e '/^[[:space:]]*$/d' "${SERIES}")
[ "${#SERIES_ENTRIES[@]}" -gt 0 ] || {
    echo "error: ${SERIES} names no patch once comments are stripped, so this run would apply none and exit 0" >&2
    exit 1
}

# Every listed patch exists...
for name in "${SERIES_ENTRIES[@]}"; do
    [ -f "${PATCHDIR}/${name}" ] || {
        echo "error: ${SERIES} names ${name}, which is not in ${PATCHDIR}" >&2
        exit 1
    }
done

# ...and every patch present is listed. An unlisted file is the failure the old
# count could be talked out of reporting.
shopt -s nullglob
for path in "${PATCHDIR}"/*.patch; do
    name="$(basename "${path}")"
    listed=0
    for entry in "${SERIES_ENTRIES[@]}"; do
        [ "${entry}" != "${name}" ] || { listed=1; break; }
    done
    [ "${listed}" -eq 1 ] || {
        echo "error: ${PATCHDIR}/${name} is not named in ${SERIES}, so it would ship in this directory and never be applied" >&2
        exit 1
    }
done
shopt -u nullglob

cd "${SRC}"
for name in "${SERIES_ENTRIES[@]}"; do
    echo ">> applying ${name}"
    case "${APPLIER}" in
    patch) patch -p1 --no-backup-if-mismatch <"${PATCHDIR}/${name}" ;;
    git) git apply -v "${PATCHDIR}/${name}" ;;
    *)
        echo "error: unknown applier '${APPLIER}'; the two this tree uses are 'patch' and 'git'" >&2
        exit 1
        ;;
    esac
done
echo "applied ${#SERIES_ENTRIES[@]} patch(es) from ${SERIES}"
