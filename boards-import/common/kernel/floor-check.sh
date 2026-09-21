#!/usr/bin/env bash
# The shared kernel floor, asserted over a RESOLVED .config: every =y line of
# common/kernel/mica-required.fragment survived olddefconfig, the LSM boot list
# is exactly the required one, and the verity trust anchor the fragment names
# is a PEM certificate in the tree. Run by the FIT families' configure.sh
# after olddefconfig; a UEFI board's kernel/Dockerfile carries the same three
# checks inline.
#
#   floor-check.sh <source-tree> <mica-required-fragment>
set -euo pipefail
[ "$#" -eq 2 ] || { echo "usage: floor-check.sh <source-tree> <mica-required-fragment>" >&2; exit 1; }
SRC="$1"
FRAGMENT="$2"
cd "${SRC}"
# THE REACH, BEFORE ANY CLAIM ABOUT WHAT IS IN THE FILE. Every assertion below
# is a grep over .config, and an absent file and an absent symbol are the same
# exit status: without this line a tree with no resolved config is refused for
# the first thing that happens to be checked, and the error names the trust
# anchor when the real fault is that olddefconfig never ran.
[ -f .config ] || { echo "error: ${SRC} has no .config, so nothing below is a statement about a resolved configuration. olddefconfig has not run in this tree." >&2; exit 1; }

trusted_keys="$(grep '^CONFIG_SYSTEM_TRUSTED_KEYS=' "${FRAGMENT}")"
[ -n "${trusted_keys}" ] || {
    echo "error: ${FRAGMENT} declares no CONFIG_SYSTEM_TRUSTED_KEYS, so this assertion has nothing to compare and would pass over a kernel that trusts nothing" >&2
    exit 1
}
grep -q "^${trusted_keys}$" .config || {
    echo "error: the resolved config's trust anchor is not the required one. Wanted ${trusted_keys}, got $(grep '^CONFIG_SYSTEM_TRUSTED_KEYS=' .config || echo none)." >&2
    exit 1
}
anchor="$(printf '%s' "${trusted_keys}" | sed 's/^CONFIG_SYSTEM_TRUSTED_KEYS=//; s/^"//; s/"$//')"
[ -s "${anchor}" ] || {
    echo "error: ${trusted_keys} names ${anchor}, which does not exist in the kernel tree. certs/Makefile resolves that path against the source tree; the compile would fail at extract-cert" >&2
    exit 1
}
grep -q 'BEGIN CERTIFICATE' "${anchor}" || {
    echo "error: ${anchor} is not a PEM certificate. The mica-trust build context delivered something else, and extract-cert would refuse it in the middle of the compile" >&2
    exit 1
}
echo "config: ${trusted_keys} ($(stat -c%s "${anchor}") bytes)"

lsm="$(grep '^CONFIG_LSM=' "${FRAGMENT}")"
[ -n "${lsm}" ] || { echo "error: ${FRAGMENT} declares no CONFIG_LSM, so this assertion has nothing to compare" >&2; exit 1; }
grep -q "^${lsm}$" .config || {
    echo "error: the resolved config's LSM list is not the required one. Wanted ${lsm}, got $(grep '^CONFIG_LSM=' .config || echo none). SELinux that is compiled in but not in the boot list never registers selinuxfs, and the image ships a security module that is present and does nothing." >&2
    exit 1
}
echo "config: ${lsm}"

n=0
for line in $(sed -n 's/^\(CONFIG_[A-Z0-9_]*=y\)$/\1/p' "${FRAGMENT}"); do
    n=$((n + 1))
    grep -q "^${line}$" .config || {
        echo "missing mica-required option: ${line}" >&2
        exit 1
    }
done
[ "${n}" -gt 0 ] || { echo "error: zero =y lines were read from ${FRAGMENT}, so the loop above asserted nothing" >&2; exit 1; }
echo "config: all ${n} required =y options of the shared floor are set"

# THE OFF HALF OF THE FLOOR, WHICH UNTIL NOW NOTHING ASSERTED. A
# `# CONFIG_X is not set` line in the fragment is a decision, measured and
# recorded the same way an =y line is, and merge_config writes it into the
# input -- but olddefconfig turns a symbol back on the moment something
# `select`s it or the vendor defconfig moves, and the loop above cannot see
# that because it only reads =y lines. The claim asserted here is "no line
# turns it on", which is the right shape: a symbol whose dependencies are
# unmet does not appear in a resolved config at all, so requiring the literal
# "is not set" line would refuse a kernel that is off in the stronger sense.
# The reach is proved by the =y loop above having found its symbols in this
# same file: a grep that matches nothing here is evidence only because a grep
# over the same file matched something there.
off=0
for sym in $(sed -n 's/^# \(CONFIG_[A-Z0-9_]*\) is not set$/\1/p' "${FRAGMENT}"); do
    off=$((off + 1))
    ! grep -q "^${sym}=" .config || {
        echo "error: ${FRAGMENT} records ${sym} off and the resolved config has $(grep "^${sym}=" .config). Something selects it or the vendor defconfig moved; the line in the fragment is a decision with a measurement behind it, not a default." >&2
        exit 1
    }
done
[ "${off}" -gt 0 ] || { echo "error: zero 'is not set' lines were read from ${FRAGMENT}, so the loop above asserted nothing" >&2; exit 1; }
echo "config: all ${off} options the shared floor records off are off"
