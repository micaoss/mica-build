#!/usr/bin/env bash
# A board's kernel floor, composed: fragments/core.fragment and the fragment of
# every kernel feature the board names (board.env KERNEL_FEATURES), in the
# order of features.tsv, then the LSM boot list those features add up to. The
# result is the one file a board's kernel build merges before olddefconfig,
# asserts after it (floor-check.sh, or the board Dockerfile's own loops) and
# ships beside the kernel as mica-required.fragment.
#
#   compose-floor.sh <common/kernel directory> "<kernel features>" > mica-required.fragment
#
# Its second line names the features, so the shipped file says which floor the
# kernel holds. Refused: a feature features.tsv has no row for, `core` named
# (every board merges it), a feature named twice, one whose required features
# the board does not name, and a missing fragment.
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: compose-floor.sh <common/kernel directory> \"<kernel features>\"" >&2; exit 2; }
DIR="$1"
read -r -a WANTED <<<"$2"
TABLE="${DIR}/features.tsv"
[ -f "${TABLE}" ] || { echo "error: ${TABLE} does not exist; the kernel features are read from it" >&2; exit 1; }
[ "$(head -n 1 "${TABLE}")" = '# mica kernel features v1' ] || { echo "error: ${TABLE}: the first line is not '# mica kernel features v1'" >&2; exit 1; }

names=() requires=() lsms=()
while IFS=$'\t' read -r name req lsm triggers extra; do
    case "${name}" in '' | '#'*) continue ;; esac
    [ -n "${triggers}" ] && [ -z "${extra:-}" ] || { echo "error: ${TABLE}: the row '${name}' does not have four columns" >&2; exit 1; }
    names+=("${name}"); requires+=("${req}"); lsms+=("${lsm}")
done <"${TABLE}"
[ "${names[0]:-}" = core ] || { echo "error: ${TABLE}: the first row is not core" >&2; exit 1; }

known() { local n; for n in "${names[@]}"; do [ "${n}" = "$1" ] && return 0; done; return 1; }
named() { local n; for n in "${WANTED[@]}"; do [ "${n}" = "$1" ] && return 0; done; return 1; }
seen=" "
for f in "${WANTED[@]}"; do
    [ "${f}" != core ] || { echo "error: KERNEL_FEATURES names core; every board merges it, and a board names only the features beside it" >&2; exit 1; }
    known "${f}" || { echo "error: KERNEL_FEATURES names '${f}', which ${TABLE} has no row for; the features are: ${names[*]:1}" >&2; exit 1; }
    case "${seen}" in *" ${f} "*) echo "error: KERNEL_FEATURES names '${f}' twice" >&2; exit 1 ;; esac
    seen="${seen}${f} "
done

selected=() lsm=""
for i in "${!names[@]}"; do
    name="${names[$i]}"
    [ "${name}" = core ] || named "${name}" || continue
    if [ "${requires[$i]}" != - ]; then
        for r in ${requires[$i]//,/ }; do
            named "${r}" || { echo "error: the kernel feature ${name} requires ${r}, and KERNEL_FEATURES does not name it" >&2; exit 1; }
        done
    fi
    [ -f "${DIR}/fragments/${name}.fragment" ] || { echo "error: ${DIR}/fragments/${name}.fragment does not exist; ${TABLE} lists the feature ${name}" >&2; exit 1; }
    selected+=("${name}")
    [ "${lsms[$i]}" = - ] || lsm="${lsm:+${lsm},}${lsms[$i]}"
done

echo '# mica-required: this board'"'"'s kernel floor, composed by common/kernel/compose-floor.sh from common/kernel/fragments/.'
echo "# mica kernel features: ${selected[*]:1}"
for name in "${selected[@]}"; do
    echo
    echo "# ==== fragments/${name}.fragment ===="
    cat "${DIR}/fragments/${name}.fragment"
done
echo
echo '# The LSM boot list: the security modules of core and of each feature above, in features.tsv order. A module'
echo '# must be in it or it never registers (selinuxfs, for one); a string option, so not covered by the =y'
echo '# assertion loop and asserted by name.'
echo "CONFIG_LSM=\"${lsm}\""
