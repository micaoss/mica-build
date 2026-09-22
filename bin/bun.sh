#!/usr/bin/env bash
# The one bootstrap: run bun over this tree, on the host when it has one or in
# the bun image this tree pins, so that a host with no bun is a supported host.
#
#   bash bin/bun.sh <bun arguments...>        e.g. bash bin/bun.sh src/cli.ts test
#
# Two routes, one seam. A bun binary on the host (MICA_BUN names one; otherwise
# the first on PATH, then ~/.bun/bin/bun), or MICA_BUN_CONTAINER=1 and the
# digest-pinned image recorded as mica-build-env:base in locks/mica-build-env.lock,
# plus the docker client and buildx pinned as upstream:docker:28-cli (bin/Dockerfile),
# because the tree's commands drive docker themselves. A caller passes an argv
# and reads an exit status and cannot tell which route it got.
#
# The container route mounts the tree at its own path, the docker socket, and the
# git directories a linked worktree keeps outside the tree (so the source identity
# read inside is the tree's), and it tells git that the mounted tree is safe:
# the container runs as root over a tree the host user owns. Every mount is
# checked from inside before the run, because a bind mount of a path the daemon
# cannot share arrives as an empty directory and not as an error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
for anchor in "${REPO_ROOT}/Makefile" "${REPO_ROOT}/package.json" "${REPO_ROOT}/src/cli.ts" "${REPO_ROOT}/locks/pins"; do
    [ -e "${anchor}" ] || { echo "bin/bun.sh: error: ${anchor} does not exist; bin/ moved or the tree is not a checkout" >&2; exit 1; }
done
[ "$#" -gt 0 ] || { echo "usage: bash bin/bun.sh <bun arguments...>" >&2; exit 2; }

BUN="${MICA_BUN:-}"
if [ -n "${BUN}" ] && [ "${MICA_BUN_CONTAINER:-0}" = 1 ]; then
    echo "bin/bun.sh: error: MICA_BUN names a binary and MICA_BUN_CONTAINER asks for the pinned container; set one" >&2
    exit 1
fi
ROUTE=host
WHY=""
if [ "${MICA_BUN_CONTAINER:-0}" = 1 ]; then
    ROUTE=container; WHY="MICA_BUN_CONTAINER=1"
elif [ -z "${BUN}" ]; then
    if command -v bun >/dev/null 2>&1; then BUN="$(command -v bun)"
    elif [ -x "${HOME:-/root}/.bun/bin/bun" ]; then BUN="${HOME:-/root}/.bun/bin/bun"
    else ROUTE=container; WHY="no bun on this host"; fi
fi

# The dev dependencies, when the tree has a lockfile and they are not installed yet (a fixture checkout
# carrying no lockfile runs without them).
needs_install() { [ -f "${REPO_ROOT}/bun.lock" ] && [ ! -d "${REPO_ROOT}/node_modules" ]; }

if [ "${ROUTE}" = host ]; then
    ! needs_install || (cd "${REPO_ROOT}" && "${BUN}" install --frozen-lockfile)
    cd "${REPO_ROOT}" && exec "${BUN}" "$@"
fi

# --- the container route ---
DOCKER="${MICA_BUILD_DOCKER:-docker}"
command -v "${DOCKER}" >/dev/null 2>&1 || {
    echo "bin/bun.sh: error: no bun on this host (${WHY}) and no docker to run the pinned one in" >&2
    exit 1
}
case "${DOCKER_HOST:-}" in
"") DOCKER_SOCK=/var/run/docker.sock ;;
unix://*) DOCKER_SOCK="${DOCKER_HOST#unix://}" ;;
*) echo "bin/bun.sh: error: DOCKER_HOST=${DOCKER_HOST} is not a unix:// socket, and the container route mounts the socket" >&2; exit 1 ;;
esac
[ -S "${DOCKER_SOCK}" ] || { echo "bin/bun.sh: error: ${DOCKER_SOCK} is not a socket" >&2; exit 1; }

# One resolver, the tree's own: from.sh refuses a tag and a malformed reference.
BUN_IMAGE="$(bash "${REPO_ROOT}/tools/from.sh" --ref mica-build-env:base)"
CLI_IMAGE="$(bash "${REPO_ROOT}/tools/from.sh" --ref upstream:docker:28-cli)"
for image in "${BUN_IMAGE}" "${CLI_IMAGE}"; do
    "${DOCKER}" image inspect "${image}" >/dev/null 2>&1 || "${DOCKER}" pull -q "${image}" >/dev/null || {
        echo "bin/bun.sh: error: ${image} could not be obtained; locks/mica-build-env.lock records it and this host cannot reach it" >&2
        exit 1
    }
done
# Both digests in the tag, so a bumped pin never reuses an image built from the previous one.
stamp="$(printf '%s\n%s\n%s\n' "${BUN_IMAGE}" "${CLI_IMAGE}" "$(sha256sum "${HERE}/Dockerfile")" | sha256sum | cut -c1-16)"
TOOLS_IMAGE="ai-agent/mica-build-bun:${stamp}"
if ! "${DOCKER}" image inspect "${TOOLS_IMAGE}" >/dev/null 2>&1; then
    echo "bin/bun.sh: building ${TOOLS_IMAGE} (the pinned bun plus the pinned docker client and buildx)"
    "${DOCKER}" build -q --label ai-agent=true -t "${TOOLS_IMAGE}" \
        --build-arg "MICA_BUN_IMAGE=${BUN_IMAGE}" --build-arg "MICA_DOCKER_CLI_IMAGE=${CLI_IMAGE}" \
        -f "${HERE}/Dockerfile" "${HERE}" >/dev/null
fi

# The station container sees /work and /root where the host daemon sees /srv/station/...
host_path() {
    case "$1" in
    /work/*) printf '/srv/station/work/%s\n' "${1#/work/}" ;;
    /root/*) printf '/srv/station/root/%s\n' "${1#/root/}" ;;
    *) printf '%s\n' "$1" ;;
    esac
}
MOUNTS=(-v "$(host_path "${REPO_ROOT}"):${REPO_ROOT}" -v "${DOCKER_SOCK}:/var/run/docker.sock")
PREFLIGHT=("${REPO_ROOT}/package.json" "${REPO_ROOT}/src/cli.ts")
# The git metadata is read inside (the source identity of a release, the tree's commit on an own pool
# row) and never written: .git -- a directory, or the gitfile of a linked worktree -- is mounted read-only
# over the tree, and so are the directories a linked worktree keeps outside it.
if [ -e "${REPO_ROOT}/.git" ]; then
    MOUNTS+=(-v "$(host_path "${REPO_ROOT}/.git"):${REPO_ROOT}/.git:ro"); PREFLIGHT+=("${REPO_ROOT}/.git")
fi
if command -v git >/dev/null 2>&1 && git -C "${REPO_ROOT}" rev-parse --git-dir >/dev/null 2>&1; then
    git_dir="$(cd "$(git -C "${REPO_ROOT}" --no-optional-locks rev-parse --absolute-git-dir)" && pwd -P)"
    common_dir="$(cd "$(git -C "${REPO_ROOT}" --no-optional-locks rev-parse --path-format=absolute --git-common-dir)" && pwd -P)"
    for d in "${common_dir}" "${git_dir}"; do
        case "${d}/" in "${REPO_ROOT}/"*) continue ;; esac
        MOUNTS+=(-v "$(host_path "${d}"):${d}:ro"); PREFLIGHT+=("${d}/HEAD")
    done
fi
probe="$("${DOCKER}" run --rm "${MOUNTS[@]}" "${TOOLS_IMAGE}" \
    sh -c 'bun --version; for f in "$@"; do [ -e "$f" ] || printf "unseen:%s\n" "$f"; done' sh "${PREFLIGHT[@]}" 2>&1)" || {
    echo "bin/bun.sh: error: the pinned bun container would not start:" >&2; printf '%s\n' "${probe}" >&2; exit 1
}
unseen="$(printf '%s\n' "${probe}" | sed -n 's/^unseen://p')"
[ -z "${unseen}" ] || {
    echo "bin/bun.sh: error: the pinned bun container cannot see paths this host can (a bind mount the daemon cannot share):" >&2
    printf '  %s\n' ${unseen} >&2; exit 1
}
echo "bin/bun.sh: bun $(printf '%s\n' "${probe}" | sed -n 1p) in ${TOOLS_IMAGE} (${WHY})"
run() {
    "${DOCKER}" run --rm --label ai-agent=true --network traefik "${MOUNTS[@]}" -w "${REPO_ROOT}" \
        -e MICA_BUILD_DOCKER=docker -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
        "${TOOLS_IMAGE}" bun "$@"
}
! needs_install || run install --frozen-lockfile
exec "${DOCKER}" run --rm --label ai-agent=true --network traefik "${MOUNTS[@]}" -w "${REPO_ROOT}" \
    -e MICA_BUILD_DOCKER=docker -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${TOOLS_IMAGE}" bun "$@"
