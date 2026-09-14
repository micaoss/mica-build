#!/usr/bin/env bash
# The build-env images this repository builds in: build-env-image.lock.
#
#   bash tools/build-env.sh verify    the lock is its release's (downloads SHA256SUMS, no credential)
#   bash tools/build-env.sh check     the lock and its record are well formed, no network
#
# build-env-image.lock is the asset of the mica-build-env release named in
# build-env-release, committed unchanged. A consumer records the release tag
# and the sha256 of its SHA256SUMS, and refuses the lock unless SHA256SUMS
# hashes to that value and names the lock's bytes (mica-build-env RULES.md 1).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
LOCK="${MICA_BUILD_ENV_LOCK:-${REPO_ROOT}/build-env-image.lock}"
RECORD="${MICA_BUILD_ENV_RECORD:-${REPO_ROOT}/build-env-release}"
URL_BASE="${MICA_BUILD_ENV_RELEASES:-https://github.com/micaoss/mica-build-env/releases/download}"
USED_KEYS=(IMAGE_MICA_BUILD_BASE IMAGE_MICA_BUILD_C IMAGE_MICA_BUILD_RUST)

die() { echo "build-env.sh: error: $*" >&2; exit 1; }

check_record() {
    [ -f "${RECORD}" ] || die "${RECORD} does not exist; it records the release build-env-image.lock came from"
    local keys
    keys="$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' -e 's/=.*//' "${RECORD}" | LC_ALL=C sort | tr '\n' ' ')"
    [ "${keys}" = "BUILD_ENV_RELEASE BUILD_ENV_SHA256SUMS " ] ||
        die "${RECORD} must hold exactly BUILD_ENV_RELEASE and BUILD_ENV_SHA256SUMS, once each; it holds: ${keys:-nothing}"
    RELEASE="$(sed -n 's/^BUILD_ENV_RELEASE=//p' "${RECORD}")"
    TRUST="$(sed -n 's/^BUILD_ENV_SHA256SUMS=//p' "${RECORD}")"
    [[ "${RELEASE}" =~ ^[0-9]{8}-[0-9]{4}$ ]] || die "BUILD_ENV_RELEASE='${RELEASE}' is not a release tag YYYYMMDD-HHMM"
    [[ "${TRUST}" =~ ^[0-9a-f]{64}$ ]] || die "BUILD_ENV_SHA256SUMS='${TRUST}' is not 64 lowercase hex"
}

check_lock() {
    [ -f "${LOCK}" ] || die "${LOCK} does not exist; it is the build-env-image.lock asset of release ${RELEASE}"
    local line key value seen=" "
    while IFS= read -r line || [ -n "${line}" ]; do
        case "${line}" in '' | '#'*) continue ;; esac
        [[ "${line}" =~ ^(IMAGE_MICA_BUILD_[A-Z0-9_]+)=(.*)$ ]] || die "${LOCK} holds a line that is not IMAGE_MICA_BUILD_<NAME>=<reference>: ${line}"
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        case "${seen}" in *" ${key} "*) die "${LOCK} gives ${key} more than once" ;; esac
        seen="${seen}${key} "
        [[ "${value}" =~ ^ghcr\.io/micaoss/mica-build-env:[a-z0-9-]+\.inputs-[0-9a-f]{16}@sha256:[0-9a-f]{64}$ ]] ||
            die "${key}=${value} is not ghcr.io/micaoss/mica-build-env:<image>.inputs-<16 hex>@sha256:<64 hex>"
    done <"${LOCK}"
    for key in "${USED_KEYS[@]}"; do
        case "${seen}" in *" ${key} "*) ;; *) die "${LOCK} gives no ${key}, which this repository builds in" ;; esac
    done
}

usage() { die "usage: bash tools/build-env.sh verify | check"; }
[ "$#" -eq 1 ] || usage
case "$1" in
check)
    check_record
    check_lock
    echo "build-env.sh: build-env-image.lock and build-env-release are well formed (release ${RELEASE})"
    ;;
verify)
    for t in curl sha256sum; do
        command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"
    done
    check_record
    [ -f "${LOCK}" ] || die "${LOCK} does not exist; it is the build-env-image.lock asset of release ${RELEASE}"
    work="$(mktemp -d)"
    trap 'rm -rf "${work}"' EXIT
    curl -fsSL --retry 3 --max-time 120 -o "${work}/SHA256SUMS" "${URL_BASE}/${RELEASE}/SHA256SUMS" ||
        die "downloading ${URL_BASE}/${RELEASE}/SHA256SUMS failed"
    got="$(sha256sum "${work}/SHA256SUMS" | cut -d' ' -f1)"
    [ "${got}" = "${TRUST}" ] || die "SHA256SUMS of ${RELEASE} hashes to ${got}, and ${RECORD} records ${TRUST}"
    want="$(sed -n 's/^\([0-9a-f]\{64\}\)  build-env-image\.lock$/\1/p' "${work}/SHA256SUMS")"
    [ "$(grep -c . "${work}/SHA256SUMS")" = 1 ] && [ -n "${want}" ] ||
        die "SHA256SUMS of ${RELEASE} does not list exactly build-env-image.lock"
    have="$(sha256sum "${LOCK}" | cut -d' ' -f1)"
    [ "${have}" = "${want}" ] || die "${LOCK} hashes to ${have}, not to ${want} as SHA256SUMS of ${RELEASE} names; the lock is committed unchanged"
    check_lock
    echo "build-env.sh: build-env-image.lock is the lock of mica-build-env ${RELEASE} (SHA256SUMS ${TRUST:0:12}, lock ${have:0:12}), verified"
    ;;
*) usage ;;
esac
