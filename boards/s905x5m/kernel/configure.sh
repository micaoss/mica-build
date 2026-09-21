#!/usr/bin/env bash
# mica-build-side: container. Resolve an amlogic board's kernel configuration
# and prove the result carries the floor, before anything is compiled.
#
#   configure.sh <source-tree> <mica-required-fragment> <board-config-dir> "<fragments>" <board-hooks-dir>
#
# <fragments> is the board's merge order (bsp.env KERNEL_FRAGMENTS): file
# names under <board-config-dir>, with @mica-required standing for the shared
# floor. CROSS_COMPILE comes from the environment (empty on a native builder).
# In order: LOCALVERSION_AUTO off, the board's configure hook, the merge,
# olddefconfig, the shared floor (common/kernel/floor-check.sh),
# every =y and =m line of the board's fragments, the board's assert hook.
set -euo pipefail
[ "$#" -eq 5 ] || {
    echo "usage: configure.sh <source-tree> <mica-required-fragment> <board-config-dir> \"<fragments>\" <board-hooks-dir>" >&2
    exit 1
}
SRC="$1"
FRAGMENT="$2"
CONFIG_DIR="$3"
FRAGMENTS="$4"
HOOKS="$5"
[ -f "${FRAGMENT}" ] || { echo "error: ${FRAGMENT} does not exist; the mica-common build context did not arrive" >&2; exit 1; }
[ -n "${FRAGMENTS}" ] || { echo "error: no fragments were named (KERNEL_FRAGMENTS in bsp.env); the shared floor would never be merged" >&2; exit 1; }

cd "${SRC}"
CROSS=(ARCH=arm64 CROSS_COMPILE="${CROSS_COMPILE-}")

scripts/config --disable LOCALVERSION_AUTO
[ ! -f "${HOOKS}/configure.sh" ] || bash "${HOOKS}/configure.sh" "${SRC}"

merge=()
board=()
for f in ${FRAGMENTS}; do
    if [ "${f}" = "@mica-required" ]; then
        merge+=("${FRAGMENT}")
    else
        [ -f "${CONFIG_DIR}/${f}" ] || { echo "error: KERNEL_FRAGMENTS names ${f}, which is not in the board's kernel/config/" >&2; exit 1; }
        merge+=("${CONFIG_DIR}/${f}")
        board+=("${CONFIG_DIR}/${f}")
    fi
done
case " ${FRAGMENTS} " in *" @mica-required "*) ;; *) echo "error: KERNEL_FRAGMENTS does not place @mica-required; the shared floor would never be merged" >&2; exit 1 ;; esac
env "${CROSS[@]}" scripts/kconfig/merge_config.sh -m .config "${merge[@]}"
make "${CROSS[@]}" olddefconfig

test -s .config
grep -Fqx -- 'CONFIG_ARM64=y' .config || { echo 'final .config grep control did not find CONFIG_ARM64=y' >&2; exit 1; }
bash "$(dirname "${BASH_SOURCE[0]}")/../../common/kernel/floor-check.sh" "${SRC}" "${FRAGMENT}"

if [ "${#board[@]}" -gt 0 ]; then
    for line in $(sed -n 's/^\(CONFIG_[A-Z0-9_]*=[ym]\)$/\1/p' "${board[@]}"); do
        grep -Fqx -- "${line}" .config || { echo "missing board-required option: ${line}" >&2; exit 1; }
    done
fi
[ ! -f "${HOOKS}/assert.sh" ] || bash "${HOOKS}/assert.sh" "${SRC}" "${CONFIG_DIR}"
