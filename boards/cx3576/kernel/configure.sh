#!/usr/bin/env bash
# mica-build-side: container -- kconfig and `make olddefconfig` run in the BSP
# builder image against the vendor tree fetched there; no kernel configuration
# happens on the host.
#
# Resolve a rockchip board's kernel configuration and prove the result carries
# the floor, before anything is compiled.
#
#   configure.sh <source-tree> <mica-required-fragment> <board-hooks-dir>
#
# The board's committed config is already at .config. In order: the family's
# own edit (LOCALVERSION_AUTO off, so the release string is the tree's and not
# the checkout's), the board's configure hook (its kconfig edits), the shared
# floor merged in, olddefconfig, then the assertions -- the signed-boot floor
# every FIT board holds, the trust anchor, the board's assert hook, and every
# =y line of the shared fragment.
#
# THE OUTPUT IS AN ARTEFACT. The .config this leaves behind is exported by
# kernel/Dockerfile's artifact stage and packaged as /boot/config-<release>,
# and the assembly's verifier reads it back out of the packed root. It is the
# only form of common/kernel/mica-required.fragment's floor that survives into an
# assembled image, which is why the assertions below are on the RESOLVED
# config and not on the committed input.
set -euo pipefail

[ "$#" -eq 3 ] || {
    echo "usage: configure.sh <source-tree> <mica-required-fragment> <board-hooks-dir>" >&2
    exit 1
}
SRC="$1"
FRAGMENT="$2"
HOOKS="$3"

[ -f "${FRAGMENT}" ] || {
    echo "error: ${FRAGMENT} does not exist. It arrives through the mica-common build context that the board's Makefile wires up; a bare \`docker buildx build\` without it fails here rather than building a kernel with no shared floor" >&2
    exit 1
}

cd "${SRC}"
# Passed on each command line rather than exported: a make VARIABLE assignment
# outranks anything the vendor tree's own makefiles set and an environment
# variable does not, and the difference is only visible in the compiled bytes.
CROSS=(ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu-)

scripts/config --disable LOCALVERSION_AUTO
[ ! -f "${HOOKS}/configure.sh" ] || bash "${HOOKS}/configure.sh" "${SRC}"

env "${CROSS[@]}" scripts/kconfig/merge_config.sh -m .config "${FRAGMENT}"
make "${CROSS[@]}" olddefconfig

# The signed-boot floor of a FIT board: a watchdog that cannot be disarmed
# and a forced command line requiring verity signatures.
for option in WATCHDOG_NOWAYOUT WATCHDOG_SYSFS DW_WATCHDOG CMDLINE_FORCE; do
    grep -qx "CONFIG_${option}=y" .config || { echo "missing signed-boot requirement: ${option}" >&2; exit 1; }
done
grep -q '^CONFIG_CMDLINE=".*dm_verity.require_signatures=1' .config

bash "$(dirname "${BASH_SOURCE[0]}")/../../common/kernel/floor-check.sh" "${SRC}" "${FRAGMENT}"

[ ! -f "${HOOKS}/assert.sh" ] || bash "${HOOKS}/assert.sh" "${SRC}"
