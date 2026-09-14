#!/usr/bin/env bash
# Resolve a base image key to its digest pin, and refuse everything that must
# not reach a FROM or a docker run.
#
#   bash tools/from.sh --ref IMAGE_MICA_BUILD_BASE
#       -> ghcr.io/micaoss/mica-build-env:base.inputs-...@sha256:...
#   bash tools/from.sh MICA_IMAGE_UBUNTU_2404=IMAGE_UBUNTU_2404 [...]
#       -> --build-arg
#          MICA_IMAGE_UBUNTU_2404=ubuntu:24.04@sha256:...
#   bash tools/from.sh --check
#       -> validate every key of both files, print nothing
#
# The build-env images (IMAGE_MICA_BUILD_*) come from build-env-image.lock, the
# Base root (IMAGE_MICA_SYSTEM_BASE_*) from system-base.lock, every other image
# from base-images.env; a key in two files, or in none, is refused. It builds
# and pulls nothing.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
LOCK="${REPO_ROOT}/build-env-image.lock"
BASE_IMAGES="${REPO_ROOT}/base-images.env"
SYSTEM_BASE="${REPO_ROOT}/system-base.lock"

die() { echo "from.sh: error: $*" >&2; exit 1; }

declare -A VALUE=() ORIGIN=()
load() { # <file> <key pattern> [<pattern of keys the file holds for other readers>]
    local file="$1" pattern="$2" skip="${3:-^$}" line key value
    [ -f "${file}" ] || die "${file} does not exist"
    while IFS= read -r line || [ -n "${line}" ]; do
        case "${line}" in '' | '#'*) continue ;; esac
        [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]]+)$ ]] || die "${file} holds a line that is not KEY=<reference>: ${line}"
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        [[ ! "${key}" =~ ${skip} ]] || continue
        [[ "${key}" =~ ${pattern} ]] || die "${file} may not define ${key}"
        [ -z "${ORIGIN[${key}]:-}" ] || die "${key} is defined in both ${ORIGIN[${key}]##*/} and ${file##*/}"
        VALUE["${key}"]="${value}"
        ORIGIN["${key}"]="${file}"
    done <"${file}"
}
load "${LOCK}" '^IMAGE_MICA_BUILD_[A-Z0-9_]+$'
load "${SYSTEM_BASE}" '^IMAGE_MICA_SYSTEM_BASE_[A-Z0-9_]+$' '^POOL_MICA_SYSTEM_BASE_'
load "${BASE_IMAGES}" '^IMAGE_[A-Z0-9_]+$'
for key in "${!ORIGIN[@]}"; do
    [ "${ORIGIN[${key}]}" = "${LOCK}" ] || [[ ! "${key}" =~ ^IMAGE_MICA_BUILD_ ]] ||
        die "${key} is a build-env image; it comes only from build-env-image.lock"
    [ "${ORIGIN[${key}]}" = "${SYSTEM_BASE}" ] || [[ ! "${key}" =~ ^IMAGE_MICA_SYSTEM_BASE_ ]] ||
        die "${key} is a Base image; it comes only from system-base.lock"
done

resolve() { # <key>
    local key="$1" value
    [ -n "${VALUE[${key}]:-}" ] || die "no image key ${key} in build-env-image.lock, system-base.lock or base-images.env"
    value="${VALUE[${key}]}"
    [[ "${value}" =~ ^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] ||
        die "${key}=${value} (${ORIGIN[${key}]##*/}) is not name[:tag]@sha256:<64 lowercase hex>"
    printf '%s\n' "${value}"
}

case "${1:-}" in
--check)
    [ "$#" -eq 1 ] || die "--check takes no other argument"
    [ "${#VALUE[@]}" -gt 0 ] || die "no image key at all"
    for key in "${!VALUE[@]}"; do resolve "${key}" >/dev/null; done
    ;;
--ref)
    [ "$#" -eq 2 ] || die "--ref takes exactly one key"
    resolve "$2"
    ;;
'')
    die "usage: from.sh --ref <KEY> | <ARG>=<KEY> [...] | --check"
    ;;
*)
    for pair in "$@"; do
        [[ "${pair}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=([A-Z][A-Z0-9_]*)$ ]] || die "'${pair}' is not <ARG_NAME>=<KEY>"
        value="$(resolve "${BASH_REMATCH[2]}")"
        printf -- '--build-arg\n%s=%s\n' "${BASH_REMATCH[1]}" "${value}"
    done
    ;;
esac
