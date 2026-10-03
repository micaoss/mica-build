#!/usr/bin/env bash
# mica-build-side: container -- this clones into the BSP builder image's own
# filesystem; no upstream source tree is fetched onto the host.
#
# Fetch one upstream tree at one commit, and prove it is that commit.
#
#   fetch-source.sh /ksrc https://github.com/armbian/linux-rockchip.git <sha>
#
# `git init` + `fetch --depth=1 <sha>` rather than `clone --branch`: a branch or
# a tag is a name upstream can move, and the answer to "which source produced
# this artefact" would then be the date of the build. The rev-parse afterwards is
# not redundant with the fetch -- a server that resolves the argument to
# something else still leaves a checkout here, and the assertion is what makes
# that a failure rather than a different kernel.
#
# With --name <row> and MICA_MIRROR set, the mirrored pack of that git row is
# tried first (common/scripts/mirror.sh): one plain HTTP GET per chunk, no git
# protocol, which is the point -- it works where a vendor host or git:// does
# not. The import is the one fetch whose integrity the consumer enforces rather
# than the store: `git index-pack` hashes every object on the way in, so wrong
# bytes fail the import instead of producing a wrong tree, and the rev-parse
# assertion below -- unchanged, and the acceptance test for this path -- is
# what proves the checkout is the pinned commit.
set -euo pipefail

# --http1 pins git to HTTP/1.1 first: against some vendor hosts git over
# HTTP/2 completes the TLS handshake, opens the stream and then never
# receives the response, hanging the fetch for minutes. --submodules brings
# the tree's submodules in at depth 1 after the checkout.
HTTP1=0
SUBMODULES=0
NAME=""
TAG=""
while [ "$#" -gt 0 ]; do
    case "$1" in
    --http1) HTTP1=1; shift ;;
    --submodules) SUBMODULES=1; shift ;;
    --name) NAME="${2-}"; shift 2 ;;
    --tag) TAG="${2-}"; shift 2 ;;
    --*) echo "error: fetch-source.sh: unknown option $1" >&2; exit 1 ;;
    *) break ;;
    esac
done
[ "$#" -eq 3 ] || {
    echo "usage: fetch-source.sh [--http1] [--submodules] [--name <git row>] [--tag <ref>] <dir> <repo> <commit>" >&2
    exit 1
}
DIR="$1"
REPO="$2"
COMMIT="$3"
[ "${HTTP1}" -eq 0 ] || git config --global http.version HTTP/1.1

[ -n "${COMMIT}" ] || {
    echo "error: fetch-source.sh was given an empty commit for ${REPO}. An empty --build-arg reaches here as a fetch of nothing" >&2
    exit 1
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=common/scripts/mirror.sh
. "${HERE}/mirror.sh"

# The mirrored pack of one git row, into a fresh repository. 0: <DIR> is the
# pinned commit. 1: nothing was written and the upstream fetch must run.
mirror_pack() {
    local prefix="upstream/git/${NAME}/${COMMIT}" manifest plan pack chunk want got i=0 count
    [ -n "${NAME}" ] || return 1
    [ -n "$(mirror_base)" ] || return 1
    manifest="$(mktemp)"
    if ! mirror_get "${prefix}.json" "${manifest}"; then
        rm -f "${manifest}"
        echo "fetch-source.sh: ${NAME} ${COMMIT:0:12} is not mirrored (${MIRROR_STATUS:-no mirror configured}), fetching ${REPO}"
        return 1
    fi
    # python3 rather than jq: the build-env images carry python3 and no jq.
    plan="$(MANIFEST="${manifest}" WANT="${COMMIT}" python3 "${HERE}/git-pack-manifest.py")" || {
        rm -f "${manifest}"
        echo "error: fetch-source.sh: the mirror's manifest for ${NAME} ${COMMIT} was refused" >&2
        exit 1
    }
    rm -f "${manifest}"
    count="$(($(printf '%s\n' "${plan}" | wc -l) - 1))"
    [ "${count}" -ge 1 ] || {
        echo "error: fetch-source.sh: the mirror's manifest for ${NAME} lists no chunk" >&2
        exit 1
    }
    pack="$(mktemp)"
    chunk="$(mktemp)"
    : >"${pack}"
    while [ "${i}" -lt "${count}" ]; do
        want="$(printf '%s\n' "${plan}" | sed -n "$((i + 2))p" | cut -d' ' -f1)"
        if ! mirror_get "$(printf '%s.pack.%02d' "${prefix}" "${i}")" "${chunk}"; then
            rm -f "${pack}" "${chunk}"
            echo "fetch-source.sh: the mirror has the manifest of ${NAME} ${COMMIT:0:12} but not its chunk ${i} of ${count} (${MIRROR_STATUS}); fetching ${REPO} instead" >&2
            return 1
        fi
        got="$(mirror_sha256 "${chunk}")"
        [ "${got}" = "${want}" ] || {
            rm -f "${pack}" "${chunk}"
            echo "error: fetch-source.sh: chunk ${i} of ${NAME} ${COMMIT} hashes to ${got}, and the mirror's manifest says ${want}. A truncated or wrong chunk is refused here rather than handed to git" >&2
            exit 1
        }
        cat "${chunk}" >>"${pack}"
        i="$((i + 1))"
    done
    rm -f "${chunk}"
    want="$(printf '%s\n' "${plan}" | sed -n 1p | cut -d' ' -f1)"
    got="$(mirror_sha256 "${pack}")"
    [ "${got}" = "${want}" ] || {
        rm -f "${pack}"
        echo "error: fetch-source.sh: the joined pack of ${NAME} ${COMMIT} hashes to ${got}, and the mirror's manifest says ${want}" >&2
        exit 1
    }
    git init -q "${DIR}"
    git -C "${DIR}" remote add origin "${REPO}"
    git -C "${DIR}" index-pack --stdin <"${pack}" >/dev/null
    rm -f "${pack}"
    printf '%s\n' "${COMMIT}" >"${DIR}/.git/shallow"
    git -C "${DIR}" checkout -q --detach "${COMMIT}"
    echo "fetch-source.sh: ${NAME} ${COMMIT:0:12} imported from the mirror, ${count} chunk(s), ${MIRROR_REDIRECTS} redirect(s) on the last"
    return 0
}

if ! mirror_pack; then
    rm -rf "${DIR}"
    if [ -n "${TAG}" ]; then
        # --tag: the fallback clones the NAME the row pins, so that a tag moved
        # upstream is caught by the assertion below instead of passing silently
        # as it would when the fetch asks for the commit itself.
        git clone --quiet --depth 1 --branch "${TAG}" "${REPO}" "${DIR}"
    else
        git init -q "${DIR}"
        git -C "${DIR}" remote add origin "${REPO}"
        git -C "${DIR}" fetch --depth=1 origin "${COMMIT}"
        git -C "${DIR}" checkout -q --detach FETCH_HEAD
    fi
fi
got="$(git -C "${DIR}" rev-parse HEAD)"
[ "${got}" = "${COMMIT}" ] || {
    if [ -n "${TAG}" ]; then
        echo "error: ${REPO} ${TAG} is commit ${got}, but locks/upstream.lock pins ${COMMIT}. Either the tag was moved upstream or the pin is stale; do not paste the new commit in without finding out which" >&2
    else
        echo "error: ${REPO} was asked for ${COMMIT} and ${DIR} is at ${got}" >&2
    fi
    exit 1
}
[ "${SUBMODULES}" -eq 0 ] || git -C "${DIR}" submodule update --init --recursive --depth=1
