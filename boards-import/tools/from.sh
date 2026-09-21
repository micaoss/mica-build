#!/usr/bin/env bash
# Every base image this repository builds on, by digest, out of
# locks/mica-build-env.lock and nothing else: the mica-build-env images by
# their names (base, c, go, rust), third-party images by their original names
# from its upstream rows (ubuntu:24.04, debian:trixie-slim).
#
#   bash tools/from.sh --ref <image>                      a mica-build-env image, its index
#   bash tools/from.sh --arch=<amd64|arm64> --ref <image> that image's platform manifest
#   bash tools/from.sh --upstream <name>                  a third-party image, its original reference
#   bash tools/from.sh <ARG_NAME>=<spec> [...]            --build-arg lines, one per pair;
#                                                         <spec> is mica-build-env:<image> or upstream:<name>
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCK="${MICA_LOCKS_DIR:-${REPO_ROOT}/locks}/mica-build-env.lock"
die() { echo "from.sh: error: $*" >&2; exit 1; }
[ -f "${LOCK}" ] || die "${LOCK} does not exist"

row() { # <source> <name> <platform>
    awk -F'\t' -v s="$1" -v n="$2" -v p="$3" '$1 == "image" && $2 == s && $3 == n && $4 == p { print $5; found = 1 } END { exit !found }' "${LOCK}"
}
build_env() { # <image> <platform>
    row mica-build-env "$1" "$2" || die "${LOCK} has no image row for mica-build-env $1 $2"
}
upstream() { # <name>; an upstream row names the index digest on every platform row, and amd64 is always present
    row upstream "$1" amd64 || die "${LOCK} lists no upstream image $1; a third-party image is taken only from mica-build-env's upstream rows"
}

platform=index
case "${1-}" in --arch=amd64 | --arch=arm64) platform="${1#--arch=}"; shift ;; --arch=*) die "$1 is not amd64 or arm64" ;; esac
case "${1-}" in
--ref)
    [ "$#" -eq 2 ] || die "usage: from.sh [--arch=<amd64|arm64>] --ref <image>"
    build_env "$2" "${platform}"
    ;;
--upstream)
    [ "$#" -eq 2 ] && [ "${platform}" = index ] || die "usage: from.sh --upstream <name>"
    upstream "$2"
    ;;
*)
    [ "$#" -gt 0 ] && [ "${platform}" = index ] || die "usage: from.sh [--arch=<amd64|arm64>] --ref <image> | --upstream <name> | <ARG_NAME>=<spec> [...]"
    out=()
    for pair in "$@"; do
        [[ "${pair}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(mica-build-env|upstream):(.+)$ ]] || die "'${pair}' is not <ARG_NAME>=mica-build-env:<image> or <ARG_NAME>=upstream:<name>"
        arg="${BASH_REMATCH[1]}"
        if [ "${BASH_REMATCH[2]}" = upstream ]; then value="$(upstream "${BASH_REMATCH[3]}")"; else value="$(build_env "${BASH_REMATCH[3]}" index)"; fi
        out+=(--build-arg "${arg}=${value}")
    done
    printf '%s\n' "${out[@]}"
    ;;
esac
