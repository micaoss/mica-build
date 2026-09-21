#!/usr/bin/env bash
# The supported boards (boards/boards.tsv, one row per board) and what a release
# of each outputs (boards/<board>/outputs.tsv, which travels in its board component).
#
#   bash tools/boards.sh list                                   the boards, one per line
#   bash tools/boards.sh arch|boot <board>                      its architecture, its boot backend
#   bash tools/boards.sh packages <board>                       the archives of its pool
#   bash tools/boards.sh components <board>                     the components its outputs.tsv names files of
#   bash tools/boards.sh files <board> <component>              that component's files
#   bash tools/boards.sh producers <board>                      the rows of tools/deb/producers.sh that build its packages
#   bash tools/boards.sh check                                  both files' form, and that they are the tree's
#   bash tools/boards.sh component-is <board> <component> <dir> <dir> holds exactly that component's files
#   bash tools/boards.sh bundle-is <board> <dir>               <dir> holds exactly the board's WHOLE bundle:
#                                                              every file row of outputs.tsv, whatever its
#                                                              component. This is the shape a consumer FETCHES
#                                                              -- the board component's files at the root,
#                                                              kernel/, uboot/ and firmware/ beside them -- and
#                                                              the shape `make offline` must assemble, so that a
#                                                              consumer building from source and one building
#                                                              from a release read the same thing.
#   bash tools/boards.sh pool-has <board> <pool dir>            <pool dir> holds exactly one archive of each of its packages
#                                                               (a pool built for every board holds others' too)
#
# boards.tsv: `# mica-boards boards v1`, then <board> TAB <arch> TAB <boot backend>,
# sorted by board. outputs.tsv: `# mica-boards board outputs v1`, then
# `package TAB <package>` and `file TAB <component> TAB <path>` rows, sorted by
# kind, then value; a component is board, kernel, uboot or firmware.
set -euo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIST="${MICA_BOARDS_LIST:-${REPO_ROOT}/boards/boards.tsv}"
BOARDS_DIR="$(dirname "${LIST}")"
die() { echo "boards.sh: error: $*" >&2; exit 1; }
[ -f "${LIST}" ] || die "${LIST} does not exist"

boards() { grep -v '^#' "${LIST}"; }
known() { boards | awk -F'\t' -v b="$1" '$1 == b { f = 1 } END { exit !f }' || die "${LIST} lists no board $1"; }
outputs() { # <board>: its rows
    local f="${BOARDS_DIR}/$1/outputs.tsv"
    [ -f "${f}" ] || die "${f} does not exist; a listed board states what its release outputs"
    grep -v '^#' "${f}"
}
packages() { outputs "$1" | awk -F'\t' '$1 == "package" { print $2 }'; }
files() { outputs "$1" | awk -F'\t' -v c="$2" '$1 == "file" && $2 == c { print $3 }'; }
components() { outputs "$1" | awk -F'\t' '$1 == "file" { print $2 }' | uniq; }
text_file() { # <file> <header>
    [ "$(head -n1 "$1")" = "$2" ] || die "$1: line 1 is not '$2'"
    [ "$(tail -c1 "$1" | od -An -tx1 | tr -d ' ')" = 0a ] && [ "$(tr -dc '\r' <"$1" | wc -c)" = 0 ] || die "$1 is not LF text with a final LF"
    ! grep -qn '^$' "$1" || die "$1 has an empty line"
}

check() {
    local board arch boot env p f
    text_file "${LIST}" "# mica-boards boards v1"
    boards | awk -F'\t' 'NF != 3 || $1 !~ /^[a-z0-9][a-z0-9-]*$/ || $2 !~ /^(amd64|arm64)$/ || $3 == "" { print; bad = 1 } END { exit bad }' >"${WORK}/bad" ||
        die "${LIST} has rows that are not <board> TAB <amd64|arm64> TAB <boot backend>: $(tr '\n' ';' <"${WORK}/bad")"
    boards | cut -f1 >"${WORK}/names"
    sort -c "${WORK}/names" 2>/dev/null && [ -z "$(uniq -d "${WORK}/names")" ] || die "${LIST} is not sorted by board, or names a board twice"
    for env in "${REPO_ROOT}"/boards/*/board.env; do
        board="$(basename "$(dirname "${env}")")"
        grep -qx -- "${board}" "${WORK}/names" || die "boards/${board}/ is not in ${LIST}; a board directory is supported only when listed"
    done
    bash "${REPO_ROOT}/tools/deb/producers.sh" >"${WORK}/producers"
    while IFS=$'\t' read -r board arch boot; do
        env="${REPO_ROOT}/boards/${board}/board.env"
        [ -f "${env}" ] || die "${LIST} lists ${board}, and boards/${board}/board.env does not exist"
        [ "$(sed -n 's/^MICA_ARCH=//p' "${env}")" = "${arch}" ] || die "${LIST} lists ${board} as ${arch}; boards/${board}/board.env says MICA_ARCH=$(sed -n 's/^MICA_ARCH=//p' "${env}")"
        [ "$(sed -n 's/^BOOT_BACKEND=//p' "${env}")" = "${boot}" ] || die "${LIST} lists ${board} as ${boot}; boards/${board}/board.env says BOOT_BACKEND=$(sed -n 's/^BOOT_BACKEND=//p' "${env}")"
        f="${BOARDS_DIR}/${board}/outputs.tsv"
        [ -f "${f}" ] || die "${f} does not exist; a listed board states what its release outputs"
        text_file "${f}" "# mica-boards board outputs v1"
        outputs "${board}" | awk -F'\t' '!(($1 == "package" && NF == 2 && $2 != "") || ($1 == "file" && NF == 3 && $2 ~ /^(board|kernel|uboot|firmware)$/ && $3 != "")) { print; bad = 1 } END { exit bad }' >"${WORK}/bad" ||
            die "${f} has rows that are not package TAB <package> or file TAB <board|kernel|uboot|firmware> TAB <path>: $(tr '\n' ';' <"${WORK}/bad")"
        outputs "${board}" | awk -F'\t' '{ printf "%d\t%s\t%s\n", ($1 == "package" ? 0 : 1), $2, $3 }' >"${WORK}/keys"
        sort -c -t$'\t' -k1,1n -k2,2 -k3,3 "${WORK}/keys" 2>/dev/null && [ -z "$(sort "${WORK}/keys" | uniq -d)" ] || die "${f} is not sorted by kind, then value, or repeats a row"
        [ -z "$(outputs "${board}" | awk -F'\t' '$1 == "file" { print $3 }' | sort | uniq -d)" ] || die "${f} names a path in two components"
        packages "${board}" >"${WORK}/packages"
        grep -qx -- "mica-board-${board}" "${WORK}/packages" || die "${f} lists no package mica-board-${board}"
        while IFS= read -r p; do
            awk -v p="${p}" -v a="${arch}" '{ n = split($4, ps, ","); for (i = 1; i <= n; i++) if (ps[i] == p && ($3 == a || $3 == "all")) f = 1 } END { exit !f }' "${WORK}/producers" ||
                die "${f} lists ${p}, and no producer builds ${p} for ${arch}"
        done <"${WORK}/packages"
        [ "$(components "${board}" | sort | tr '\n' ' ')" = "$(bash "${REPO_ROOT}/tools/component.sh" list "${board}" | sort | tr '\n' ' ')" ] ||
            die "${f} names files of the components $(components "${board}" | tr '\n' ' ')but ${board} has $(bash "${REPO_ROOT}/tools/component.sh" list "${board}" | tr '\n' ' ')(tools/component.sh)"
        files "${board}" board >"${WORK}/c"
        for p in board.env images.tsv manifests/board.pkgs outputs.tsv trust/verity-signer.cert.pem; do grep -qx -- "${p}" "${WORK}/c" || die "${f} lists no board file ${p}"; done
        ! grep -qE '^(kernel|uboot|uboot-package|firmware)/|^component-copyright$' "${WORK}/c" || die "${f} lists a kernel, uboot or firmware file in the board component"
        files "${board}" kernel >"${WORK}/c"
        ! grep -qv '^kernel/' "${WORK}/c" || die "${f} lists a kernel component file outside kernel/"
        if [ "${boot}" = uboot-fit ]; then
            for p in kernel/dev/kernel.release kernel/prod/kernel.release; do grep -qx -- "${p}" "${WORK}/c" || die "${f}: a FIT board lists no ${p}"; done
            ! grep -q '^kernel/[^/]*$' "${WORK}/c" || die "${f}: a FIT board lists kernel files outside kernel/dev/ and kernel/prod/"
        else
            grep -qx kernel/kernel.release "${WORK}/c" || die "${f} lists no kernel/kernel.release"
        fi
        files "${board}" uboot | { ! grep -qvE '^uboot(-package)?/'; } || die "${f} lists a uboot component file outside uboot/ and uboot-package/"
        files "${board}" firmware | { ! grep -qvE '^firmware/|^component-copyright$'; } || die "${f} lists a firmware component file outside firmware/ and component-copyright"
    done < <(boards)
    echo "boards.sh: ${LIST} lists $(boards | wc -l) board(s), and they and their outputs.tsv are the tree's"
}

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT
case "${1-}:$#" in
list:1) boards | cut -f1 ;;
arch:2) known "$2"; boards | awk -F'\t' -v b="$2" '$1 == b { print $2 }' ;;
boot:2) known "$2"; boards | awk -F'\t' -v b="$2" '$1 == b { print $3 }' ;;
packages:2) known "$2"; packages "$2" ;;
components:2) known "$2"; components "$2" ;;
files:3) known "$2"; files "$2" "$3" ;;
check:1) check ;;
component-is:4)
    known "$2"
    [ -d "$4" ] || die "$4 is not a directory"
    diff <(files "$2" "$3") <(cd "$4" && find . -type f | sed 's|^\./||' | sort) >"${WORK}/diff" ||
        die "$4 is not the $2 $3 component its outputs.tsv lists: $(grep '^[<>]' "${WORK}/diff" | sed 's/^</missing/; s/^>/unexpected/' | tr '\n' ';')"
    ;;
bundle-is:3)
    known "$2"
    [ -d "$3" ] || die "$3 is not a directory"
    diff <(outputs "$2" | sed -n 's/^file\t[^\t]*\t//p' | sort) \
        <(cd "$3" && find . -type f -o -type l | sed 's|^\./||' | sort) >"${WORK}/diff" ||
        die "$3 is not the $2 bundle its outputs.tsv lists: $(grep '^[<>]' "${WORK}/diff" | sed 's/^</missing/; s/^>/unexpected/' | tr '\n' ';')"
    ;;
pool-has:3)
    known "$2"
    [ -d "$3" ] || die "$3 is not a directory"
    while IFS= read -r p; do
        [ "$(find "$3" -maxdepth 1 -name "${p}_*.deb" | wc -l)" = 1 ] || die "$3 does not hold exactly one ${p} archive; the $2 pool its outputs.tsv lists needs it"
    done < <(packages "$2")
    ;;
producers:2)
    known "$2"
    packages "$2" >"${WORK}/packages"
    bash "${REPO_ROOT}/tools/deb/producers.sh" | while read -r producer dir arches packages enablement; do
        for p in $(tr ',' ' ' <<<"${packages}"); do
            if grep -qx -- "${p}" "${WORK}/packages"; then printf '%s %s %s %s %s\n' "${producer}" "${dir}" "${arches}" "${packages}" "${enablement}"; break; fi
        done
    done
    ;;
*) die "usage: bash tools/boards.sh list | arch|boot|packages|components|producers <board> | files <board> <component> | check | component-is <board> <component> <dir> | pool-has <board> <pool dir>" ;;
esac
