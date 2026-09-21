#!/usr/bin/env bash
# The release lock of this repository (mica:docs/design/release-lock.md), out of
# the rows tools/deb/publish.sh and tools/publish-components.sh left after reading
# every artifact back anonymously.
#
#   bash tools/release-lock.sh write     _out/release/<repository>.lock and SHA256SUMS listing only it
#   bash tools/release-lock.sh attach    both to the published GitHub Release of HEAD's tag, last,
#                                        then downloaded back anonymously and compared
#
#   reads   <rows>/pool.tsv, <rows>/package.tsv, <rows>/board.tsv   (tools/deb/registry.sh LOCK_ROWS)
#
# A release is one board's: the tag <board>.<YYYYMMDD-HHMM>. The lock: the release
# row (release mica-boards <board>.<YYYYMMDD-HHMM> <commit>), the board's pool row
# for its architecture, a package row per archive its outputs.tsv lists, and a
# board row per component artifact (board <board> <component> <arch> <reference>:
# board, kernel, and uboot and firmware where it has them); every reference names
# ghcr.io/micaoss (MICA_LOCK_REGISTRY for a test registry's rows). A release carries exactly the lock and SHA256SUMS; an
# attached asset with other bytes is refused, never replaced.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
# shellcheck disable=SC1091
. "${REPO_ROOT}/tools/deb/registry.sh"
die() { echo "release-lock.sh: error: $*" >&2; exit 1; }
for t in git jq curl sha256sum; do command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"; done

MODE="${1-}"
[ "$#" -eq 1 ] && { [ "${MODE}" = write ] || [ "${MODE}" = attach ]; } || die "usage: bash tools/release-lock.sh write | attach"

registry_load
registry_repo_name
release_load
TAG="${RELEASE_LABEL}"
BOARD="${RELEASE_BOARD}"
COMMIT="${RELEASE_COMMIT}"
OUT="${MICA_RELEASE_OUT:-${REPO_ROOT}/_out/release}"
LOCK="${REPO_NAME}.lock"
REFERENCE="${MICA_LOCK_REGISTRY:-${MICA_REGISTRY}}/${REPO_NAME}"
export LC_ALL=C

write() {
    local arch f
    for f in pool package board; do [ -f "${LOCK_ROWS}/${f}.tsv" ] || die "${LOCK_ROWS}/${f}.tsv does not exist; run tools/deb/publish.sh and tools/publish-components.sh first"; done
    arch="$(bash "${REPO_ROOT}/tools/boards.sh" arch "${BOARD}")"
    [ "$(cut -f1 "${LOCK_ROWS}/pool.tsv")" = "${arch}" ] || die "${LOCK_ROWS}/pool.tsv is not exactly the ${BOARD} pool for ${arch}"
    [ "$(cut -f1,2,3 "${LOCK_ROWS}/board.tsv" | sort)" = "$(bash "${REPO_ROOT}/tools/component.sh" list "${BOARD}" | sort | awk -v b="${BOARD}" -v a="${arch}" '{ printf "%s\t%s\t%s\n", b, $0, a }')" ] ||
        die "${LOCK_ROWS}/board.tsv is not exactly the ${BOARD} ${arch} components ($(bash "${REPO_ROOT}/tools/component.sh" list "${BOARD}" | tr '\n' ' '))"
    [ "$(awk -F'\t' -v a="${arch}" '$2 == a { print $1 }' "${LOCK_ROWS}/package.tsv" | sort)" = "$(bash "${REPO_ROOT}/tools/boards.sh" packages "${BOARD}" | sort)" ] &&
        [ "$(cut -f2 "${LOCK_ROWS}/package.tsv" | sort -u)" = "${arch}" ] ||
        die "${LOCK_ROWS}/package.tsv is not exactly the archives boards/boards.tsv lists for ${BOARD} at ${arch}"
    mkdir -p "${OUT}"
    {
        echo "# mica-lock v1"
        printf 'release\t%s\t%s\t%s\n' "${REPO_NAME}" "${TAG}" "${COMMIT}"
        awk -F'\t' -v r="${REFERENCE}" '{ printf "pool\t%s\t%s:%s@%s\n", $1, r, $2, $3 }' "${LOCK_ROWS}/pool.tsv" | sort -t$'\t' -k2,2
        awk -F'\t' '{ printf "package\t%s\t%s\t%s\t%s\n", $1, $2, $3, $4 }' "${LOCK_ROWS}/package.tsv" | sort -t$'\t' -k2,2 -k3,3
        awk -F'\t' -v r="${REFERENCE}" '{ printf "board\t%s\t%s\t%s\t%s:%s@%s\n", $1, $2, $3, r, $4, $5 }' "${LOCK_ROWS}/board.tsv" | sort -t$'\t' -k2,2 -k3,3
    } >"${OUT}/${LOCK}"
    result="$(bash "${REPO_ROOT}/tools/check-lock.sh" lock "${OUT}/${LOCK}")" || die "the lock this release writes is ${result}"
    (cd "${OUT}" && sha256sum -- "${LOCK}" >SHA256SUMS)
    echo "release-lock.sh: ${OUT}/${LOCK} (${result}), SHA256SUMS sha256 $(sha256sum "${OUT}/SHA256SUMS" | cut -d' ' -f1)"
}

attach() {
    local slug work n f attached missing=()
    [ -f "${OUT}/${LOCK}" ] && [ -f "${OUT}/SHA256SUMS" ] || die "${OUT} holds no ${LOCK} and SHA256SUMS; run write first"
    (cd "${OUT}" && sha256sum --quiet -c SHA256SUMS) || die "${OUT}/SHA256SUMS does not match ${LOCK}"
    command -v gh >/dev/null 2>&1 || die "gh is required to attach the assets"
    slug="$(git -C "${REPO_ROOT}" remote get-url origin | sed -E 's#^(git@github\.com:|https://github\.com/)##; s#\.git$##')"
    [[ "${slug}" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || die "origin is not a GitHub repository"
    work="$(mktemp -d)"
    trap 'rm -rf "${work}"' RETURN
    # The tag is <board>.<YYYYMMDD-HHMM>; @uri leaves it as it is and encodes anything a tag should not hold.
    gh api "repos/${slug}/releases/tags/$(jq -rn --arg t "${TAG}" '$t | @uri')" >"${work}/release.json" || die "there is no published release ${TAG} in ${slug}"
    [ "$(jq -r .draft "${work}/release.json")" = false ] || die "release ${TAG} of ${slug} is a draft"
    [ "$(git ls-remote --tags "https://github.com/${slug}.git" "refs/tags/${TAG}" "refs/tags/${TAG}^{}" | awk 'END { print $1 }')" = "${COMMIT}" ] ||
        die "tag ${TAG} at github.com/${slug} does not name HEAD ${COMMIT}"
    while IFS= read -r n; do
        case "${n}" in "${LOCK}" | SHA256SUMS) ;; *) die "release ${TAG} carries ${n}; a release carries only ${LOCK} and SHA256SUMS" ;; esac
    done < <(jq -r '.assets[].name' "${work}/release.json")
    for n in "${LOCK}" SHA256SUMS; do
        f="${OUT}/${n}"
        attached="$(jq -r --arg n "${n}" '.assets[] | select(.name == $n) | "\(.state) \(.digest)"' "${work}/release.json")"
        if [ -z "${attached}" ]; then missing+=("${f}"); continue; fi
        [ "${attached}" = "uploaded sha256:$(sha256sum "${f}" | cut -d' ' -f1)" ] ||
            die "${n} is already attached to ${TAG} as '${attached}'; a published asset is never replaced"
    done
    # The lock before SHA256SUMS: SHA256SUMS present means the lock is.
    for f in ${missing[@]+"${missing[@]}"}; do gh release upload "${TAG}" "${f}" -R "${slug}" >/dev/null; done
    for n in "${LOCK}" SHA256SUMS; do
        curl -fsSL --retry 5 --retry-delay 5 -o "${work}/${n}" "https://github.com/${slug}/releases/download/${TAG}/${n}" ||
            die "${n} of ${TAG} cannot be downloaded anonymously"
        cmp -s "${work}/${n}" "${OUT}/${n}" || die "${n} of ${TAG} downloads with other bytes"
    done
    echo "release-lock.sh: ${slug} ${TAG} carries ${LOCK} and SHA256SUMS, read back anonymously; SHA256SUMS sha256 $(sha256sum "${OUT}/SHA256SUMS" | cut -d' ' -f1)"
    sed 's/^/release-lock.sh:   /' "${OUT}/${LOCK}"
}

"${MODE}"
