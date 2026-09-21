#!/usr/bin/env bash
# The shared kernel floor over every board's committed configuration, the
# boards discovered: a UEFI board's config is kernel/config/<board>.config and
# its post-olddefconfig gate its kernel/Dockerfile; a FIT board (one with a
# bsp.env) names its config there (KERNEL_CONFIG) and its gate is its
# kernel/configure.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
n=0
for env in boards/*/board.env; do
    board="$(basename "$(dirname "${env}")")"
    if [ ! -f "boards/${board}/bsp.env" ]; then
        config="boards/${board}/kernel/config/${board}.config"; gate="boards/${board}/kernel/Dockerfile"
    else
        name="$(sed -n '/^KERNEL_CONFIG=/{s/^KERNEL_CONFIG=//;p;q;}' "boards/${board}/bsp.env")"
        [ -n "${name}" ] || { echo "error: boards/${board}/bsp.env declares no KERNEL_CONFIG" >&2; exit 1; }
        config="boards/${board}/kernel/config/${name}"; gate="boards/${board}/kernel/configure.sh"
    fi
    bash common/kernel/kernel-config-test.sh "${board}" "${config}" "${gate}"
    # A board's own guest requirements (kernel/config/<board>.required): `builtin` =y, `runtime` =y or =m.
    required="boards/${board}/kernel/config/${board}.required"
    if [ -f "${required}" ]; then
        held=0 missing=""
        while read -r kind symbol; do
            case "${kind}" in '' | '#'*) continue ;; builtin) want='y' ;; runtime) want='[ym]' ;; *) echo "error: ${required}: '${kind}' is not builtin or runtime" >&2; exit 1 ;; esac
            if grep -Eqx "CONFIG_${symbol}=${want}" "${config}"; then held=$((held + 1)); else missing="${missing} ${kind}:${symbol}=$(sed -n "s/^CONFIG_${symbol}=//p" "${config}")"; fi
        done <"${required}"
        [ "${held}" -gt 0 ] || { echo "error: ${required} lists no symbol; the check above asserted nothing" >&2; exit 1; }
        [ -z "${missing}" ] || { echo "FAIL: ${board}: ${config} does not hold what ${required} requires:${missing}" >&2; exit 1; }
        echo "PASS: ${board}: all ${held} symbols of ${required} are held"
    fi
    n=$((n + 1))
done
[ "${n}" -gt 0 ] || { echo "error: no board.env found; the loop above checked nothing" >&2; exit 1; }
echo "kernel-config-test: ${n} board(s)"
