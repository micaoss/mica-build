#!/usr/bin/env bash
# Resolve an image named in locks/ to its digest reference, and refuse
# everything that must not reach a FROM or a docker run.
#
#   bash tools/from.sh --ref mica-build-env:base
#       -> ghcr.io/micaoss/mica-build-env:base.<release>@sha256:...
#   bash tools/from.sh --ref mica-system-base:rootfs@amd64
#       -> ghcr.io/micaoss/mica-system-base@sha256:...
#   bash tools/from.sh MICA_IMAGE_UBUNTU_2404=upstream:ubuntu:24.04 [...]
#       -> --build-arg
#          MICA_IMAGE_UBUNTU_2404=docker.io/library/ubuntu:24.04@sha256:...
#   bash tools/from.sh --check
#       -> every image row of locks/ resolves, print nothing
#
# A selector is <source>:<name>[@<platform>], an image row of locks/
# (mica:docs/design/release-lock.md 1.2.1): a repository image names its
# release lock's row (the index unless a platform is given), and an upstream
# image names a row of locks/mica-build-env.lock, the only place a
# third-party image comes from. tools/locks.py checks locks/ and answers; this
# script builds and pulls nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "from.sh: error: $*" >&2; exit 1; }

resolve() { # <selector>
    [[ "$1" =~ ^[a-z0-9][a-z0-9-]*:[a-z0-9][a-z0-9._/:-]*(@(index|amd64|arm64|386))?$ ]] ||
        die "'$1' is not an image selector <source>:<name>[@<platform>]"
    python3 "${HERE}/locks.py" image "$1" || die "no image row for $1 in locks/ (see above)"
}

case "${1:-}" in
--check)
    [ "$#" -eq 1 ] || die "--check takes no other argument"
    python3 "${HERE}/locks.py" rows image | while IFS=$'\t' read -r _ source name platform _; do
        resolve "${source}:${name}@${platform}" >/dev/null
    done
    ;;
--ref)
    [ "$#" -eq 2 ] || die "--ref takes exactly one selector"
    resolve "$2"
    ;;
'')
    die "usage: from.sh --ref <selector> | <ARG>=<selector> [...] | --check"
    ;;
*)
    for pair in "$@"; do
        [[ "${pair}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.+)$ ]] || die "'${pair}' is not <ARG_NAME>=<selector>"
        arg="${BASH_REMATCH[1]}"
        value="$(resolve "${BASH_REMATCH[2]}")"
        printf -- '--build-arg\n%s=%s\n' "${arg}" "${value}"
    done
    ;;
esac
