#!/usr/bin/env bash
# The NEGATIVE half of common/kernel/floor-check.sh, which the FIT boards run
# over a resolved .config after olddefconfig.
#
# WHY IT EXISTS. Until 2026-09-20 that script asserted only the =y lines of
# common/kernel/mica-required.fragment. The nine `# CONFIG_X is not set` lines
# were merged into the input and then never looked at again, so a symbol the
# fragment records off could come back on -- a new `select`, a vendor
# defconfig bump -- and every gate in the tree stayed green. The floor had a
# half nobody checked, and the sweep that found it cost one grep.
#
# The refusals below never fire on a real board, because every real board
# holds the floor; a refusal that never refuses is not a refusal, so they are
# exercised here over synthetic source trees.
#
# ONE DEFECT PER FIXTURE: a fixture that violates two rules tests neither,
# because the script may refuse it for the other one.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHECK="${REPO_ROOT}/common/kernel/floor-check.sh"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
mkdir -p "${REPO_ROOT}/tmp"
T="$(mktemp -d "${REPO_ROOT}/tmp/floor-fixtures.XXXXXX")"
trap 'rm -rf "${T}"' EXIT

# A complete, passing pair: a source tree with its resolved .config and the
# anchor the fragment names, and a fragment stating both halves of a floor.
# Every fixture below is this pair with exactly one thing changed.
fragment() { # <path>
    cat >"$1" <<'FRAGMENT'
CONFIG_SYSTEM_TRUSTED_KEYS="certs/anchor.pem"
CONFIG_LSM="landlock,lockdown,yama,integrity,selinux,bpf"
CONFIG_MEMCG=y
CONFIG_CFS_BANDWIDTH=y
# CONFIG_CGROUP_RDMA is not set
# CONFIG_TASKSTATS is not set
FRAGMENT
}

tree() { # <dir>
    mkdir -p "$1/certs"
    printf -- '-----BEGIN CERTIFICATE-----\nZm9v\n-----END CERTIFICATE-----\n' >"$1/certs/anchor.pem"
    cat >"$1/.config" <<'CONFIG'
CONFIG_SYSTEM_TRUSTED_KEYS="certs/anchor.pem"
CONFIG_LSM="landlock,lockdown,yama,integrity,selinux,bpf"
CONFIG_MEMCG=y
CONFIG_CFS_BANDWIDTH=y
# CONFIG_CGROUP_RDMA is not set
# CONFIG_TASKSTATS is not set
CONFIG
}

fixture() { # <name> -> sets SRC and FRAG for the caller
    SRC="${T}/$1/src"
    FRAG="${T}/$1/mica-required.fragment"
    mkdir -p "${T}/$1"
    tree "${SRC}"
    fragment "${FRAG}"
}

expect() { # <accept|refuse> <name> <message>
    local want="$1" name="$2" msg="$3" out
    if out="$(bash "${CHECK}" "${T}/${name}/src" "${T}/${name}/mica-required.fragment" 2>&1)"; then
        [ "${want}" = accept ] && pass "${msg}" || fail "${msg} (accepted: ${out})"
    else
        [ "${want}" = refuse ] && pass "${msg}" || fail "${msg} (refused: ${out})"
    fi
}

fixture clean
expect accept clean "a resolved config holding both halves of the floor is accepted"

# The case this file was written for.
fixture off-is-on
sed -i 's/^# CONFIG_TASKSTATS is not set$/CONFIG_TASKSTATS=y/' "${SRC}/.config"
expect refuse off-is-on "a symbol the fragment records off, resolved =y, is refused"

fixture off-is-module
sed -i 's/^# CONFIG_CGROUP_RDMA is not set$/CONFIG_CGROUP_RDMA=m/' "${SRC}/.config"
expect refuse off-is-module "a symbol the fragment records off, resolved =m, is refused"

# Off in the stronger sense: kconfig omits a symbol whose dependencies are
# unmet, so requiring the literal "is not set" line would refuse a kernel that
# cannot have the option at all.
fixture off-is-absent
sed -i '/^# CONFIG_TASKSTATS is not set$/d' "${SRC}/.config"
expect accept off-is-absent "a symbol absent from the resolved config counts as off"

# The empty-parse guard: a fragment stating no off lines asserts nothing, and
# a loop that asserts nothing must say so rather than report success.
fixture no-off-lines
sed -i '/ is not set$/d' "${FRAG}"
expect refuse no-off-lines "a fragment with no off lines is refused rather than passed"

fixture no-on-lines
sed -i '/=y$/d' "${FRAG}"
expect refuse no-on-lines "a fragment with no =y lines is refused rather than passed"

# The pre-existing half, kept here so the two cannot drift apart: this file is
# the only place either loop is exercised negatively.
fixture missing-on
sed -i '/^CONFIG_MEMCG=y$/d' "${SRC}/.config"
expect refuse missing-on "an =y line of the fragment dropped by olddefconfig is refused"

fixture no-config
rm "${SRC}/.config"
expect refuse no-config "a source tree with no resolved config is refused"

echo "floor-check-fixtures: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" = 0 ]
