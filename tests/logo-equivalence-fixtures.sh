#!/usr/bin/env bash
# The NEGATIVE half of the five-artefact equivalence in board-contract-test.sh.
#
# Every real board now sets BOARD_BOOT_LOGO=1 and carries all five artefacts,
# so the check in the contract test only ever exercises its positive case. A
# refusal that never refuses is the same defect as a suite named for a chain
# that never runs the chain, so the refusals are exercised here, over synthetic
# board directories built for the purpose.
#
# ONE DEFECT PER FIXTURE, DELIBERATELY: a negative fixture that violates two
# rules tests neither, because the reader may refuse it for the other one
# (mica-core, 2026-09-20). Each board below is a complete, valid five-artefact
# board with exactly one thing removed or added.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS=0
FAIL=0
pass() { PASS=$((PASS + 1)); echo "PASS: $1"; }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }
mkdir -p "${REPO_ROOT}/tmp"
T="$(mktemp -d "${REPO_ROOT}/tmp/logo-fixtures.XXXXXX")"
trap 'rm -rf "${T}"' EXIT

# The same five predicates the contract test applies, over a directory rather
# than over boards/<board>. Kept here as one function so the two cannot drift
# into different definitions of "present".
artefacts() { # <board dir> -> the count, 0..5
    local d="$1" n=0
    grep -rqsE '^CONFIG_LOGO=y$|--enable LOGO( |$)' "${d}/kernel/" && n=$((n + 1))
    case "$(sed -n 's/^BOARD_CMDLINE_ARGS=//p' "${d}/board.env")" in
    *fbcon=logo-pos:*vt.global_cursor_default=0* | *vt.global_cursor_default=0*fbcon=logo-pos:*) n=$((n + 1)) ;;
    esac
    grep -rqs mklogo "${d}/kernel/" && n=$((n + 1))
    [ -f "${d}/package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf" ] && n=$((n + 1))
    [ -L "${d}/package/overlay/etc/systemd/system/getty@tty1.service" ] && n=$((n + 1))
    printf '%s' "${n}"
}

complete() { # <dir> <BOARD_BOOT_LOGO value>: a board with all five artefacts
    local d="$1" flag="$2"
    mkdir -p "${d}/kernel/config" "${d}/kernel/hooks" \
        "${d}/package/overlay/etc/systemd/logind.conf.d" \
        "${d}/package/overlay/etc/systemd/system"
    printf 'BOARD_CMDLINE_ARGS="ro fbcon=logo-pos:center,logo-count:1 vt.global_cursor_default=0"\nBOARD_BOOT_LOGO=%s\n' "${flag}" >"${d}/board.env"
    printf 'CONFIG_LOGO=y\n' >"${d}/kernel/config/board.fragment"
    printf 'python3 mklogo.py splash.png out.ppm 720 405\n' >"${d}/kernel/hooks/prepare.sh"
    printf '[Login]\nNAutoVTs=0\nReserveVT=2\n' >"${d}/package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf"
    ln -sfn /dev/null "${d}/package/overlay/etc/systemd/system/getty@tty1.service"
}

verdict() { # <dir>: what the contract test would decide
    local d="$1" flag=0 n
    grep -q '^BOARD_BOOT_LOGO=1$' "${d}/board.env" && flag=1
    n="$(artefacts "${d}")"
    if { [ "${flag}" = 1 ] && [ "${n}" = 5 ]; } || { [ "${flag}" = 0 ] && [ "${n}" = 0 ]; }; then
        printf 'accept %s' "${n}"
    else
        printf 'refuse %s' "${n}"
    fi
}

expect() { # <dir> <wanted verdict prefix> <case>
    local got; got="$(verdict "$1")"
    case "${got}" in "$2"*) pass "$3 (${got})" ;; *) fail "$3: got ${got}, wanted $2" ;; esac
}

# The positive cases, so the fixtures prove the check can say yes as well as no.
complete "${T}/all-five" 1
expect "${T}/all-five" accept "a board with the flag and all five artefacts is accepted"

mkdir -p "${T}/none/kernel" "${T}/none/package"
printf 'BOARD_CMDLINE_ARGS="ro"\nBOARD_BOOT_LOGO=0\n' >"${T}/none/board.env"
expect "${T}/none" accept "a board with neither the flag nor any artefact is accepted"

# One defect each. Every fixture below starts from the complete board and
# removes or adds exactly one thing.
complete "${T}/no-mask" 1
rm "${T}/no-mask/package/overlay/etc/systemd/system/getty@tty1.service"
expect "${T}/no-mask" refuse "the flag without the getty@tty1 mask is refused"

complete "${T}/no-dropin" 1
rm "${T}/no-dropin/package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf"
expect "${T}/no-dropin" refuse "the flag without the logind drop-in is refused"

complete "${T}/no-symbol" 1
rm "${T}/no-symbol/kernel/config/board.fragment"
expect "${T}/no-symbol" refuse "the flag without CONFIG_LOGO is refused"

complete "${T}/no-render" 1
rm "${T}/no-render/kernel/hooks/prepare.sh"
expect "${T}/no-render" refuse "the flag without the mklogo render is refused"

complete "${T}/no-cmdline" 1
sed -i 's/ fbcon=logo-pos:center,logo-count:1//' "${T}/no-cmdline/board.env"
expect "${T}/no-cmdline" refuse "the flag without fbcon=logo-pos: is refused"

complete "${T}/no-cursor" 1
sed -i 's/ vt.global_cursor_default=0//' "${T}/no-cursor/board.env"
expect "${T}/no-cursor" refuse "the flag without vt.global_cursor_default=0 is refused"

# And the other direction: artefacts without the flag. This is the case that
# would ship a policy protecting nothing -- NAutoVTs=0 on a board with no logo
# removes a VT login that works.
complete "${T}/policy-without-flag" 0
expect "${T}/policy-without-flag" refuse "the five artefacts without the flag are refused"

mkdir -p "${T}/dropin-only/kernel" "${T}/dropin-only/package/overlay/etc/systemd/logind.conf.d"
printf 'BOARD_CMDLINE_ARGS="ro"\nBOARD_BOOT_LOGO=0\n' >"${T}/dropin-only/board.env"
printf '[Login]\nNAutoVTs=0\n' >"${T}/dropin-only/package/overlay/etc/systemd/logind.conf.d/50-mica-console.conf"
expect "${T}/dropin-only" refuse "a drop-in with no flag and no logo is refused"

echo "logo-equivalence-fixtures: ${PASS} passed, ${FAIL} failed"
[ "${FAIL}" = 0 ]
