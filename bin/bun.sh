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

# The dependencies (one at run time, the xz decoder of the Debian archive reader; eslint, tsc and the bun types
# for the package scripts) are installed when the tree has a lockfile and no node_modules is found in the tree
# or above it -- bun resolves modules up the directory tree, so a fixture checkout of a test under this tree
# runs on the tree's own -- and the installer's output goes to stderr, because a caller captures stdout as the
# command's answer.
needs_install() {
    [ -f "${REPO_ROOT}/bun.lock" ] || return 1
    local d="${REPO_ROOT}"
    while :; do
        [ ! -d "${d}/node_modules" ] || return 1
        [ "${d}" != / ] || return 0
        d="$(dirname "${d}")"
    done
}

if [ "${ROUTE}" = host ]; then
    ! needs_install || (cd "${REPO_ROOT}" && "${BUN}" install --frozen-lockfile >&2)
    cd "${REPO_ROOT}" && exec "${BUN}" "$@"
fi

# --- the container route ---
# The scratch directories the tree writes into are created here, by the host user, before a container
# runs as root: a directory the container creates first is root's, and the next host-side step that
# needs it (a test's mkdtemp under .tmp/, a gate's scratch under tmp/) is refused.
mkdir -p "${REPO_ROOT}/.tmp" "${REPO_ROOT}/tmp" "${REPO_ROOT}/_out" "${REPO_ROOT}/.work"
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

# The two image references, read straight out of locks/mica-build-env.lock: the bootstrap cannot ask the
# tree's resolver (tools/from.sh runs the lock reader through this script, so a host with no bun would
# recurse forever), and the lock's rules are checked by the first command that runs. A row is
# `image <source> <name> <platform> <reference>`; the bun image is the index row of mica-build-env's base,
# the client image the one reference every platform row of the upstream docker cli carries.
lock_image() { # <source> <name>: the one reference, or a refusal
    local refs
    refs="$(awk -F'\t' -v s="$1" -v n="$2" '$1 == "image" && $2 == s && $3 == n && (s == "upstream" || $4 == "index") { print $5 }' \
        "${REPO_ROOT}/locks/mica-build-env.lock" | LC_ALL=C sort -u)"
    [ "$(printf '%s\n' "${refs}" | grep -c .)" -eq 1 ] && [[ "${refs}" == *@sha256:* ]] ||
        { echo "bin/bun.sh: error: locks/mica-build-env.lock names no one image row ${1} ${2} by digest" >&2; return 1; }
    printf '%s\n' "${refs}"
}
BUN_IMAGE="$(lock_image mica-build-env base)" || exit 1
CLI_IMAGE="$(lock_image upstream docker:28-cli)" || exit 1
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
    echo "bin/bun.sh: building ${TOOLS_IMAGE} (the pinned bun plus the pinned docker client and buildx)" >&2
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
# The harness network, when this host has it (the suites attach their containers to it); a job that never
# created it runs on the default network, which is enough for the commands that only read the tree.
NETWORK=()
! "${DOCKER}" network inspect traefik >/dev/null 2>&1 || NETWORK=(--network traefik)
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
# The environment the tree's commands read crosses into the container: CI and GITHUB_ACTIONS (the locks
# reader's CI mode, which tools/pool.sh's fixture test sets and clears), and every MICA_* variable but the
# three that steer this bootstrap. A variable set to the empty string crosses as empty, which is what a
# test that clears it means. Measured before this existed: CI run 35725871542, where an offline pin under
# GitHub Actions was not refused, because inside the container nothing said it was GitHub Actions.
ENV=()
while IFS= read -r name; do
    case "${name}" in MICA_BUN|MICA_BUN_CONTAINER|MICA_BUILD_DOCKER) continue ;; esac
    ENV+=(-e "${name}")
done < <(env | sed -n 's/^\(CI\|GITHUB_ACTIONS\|MICA_[A-Za-z0-9_]*\)=.*/\1/p')
# Announced to a terminal only: a caller that captures the command's output, stderr included, must not be
# able to tell which route it got (tests/gates/release-test.sh compares a plan's combined output; CI run
# 35728952530 showed it the announcement instead).
[ ! -t 2 ] || echo "bin/bun.sh: bun $(printf '%s\n' "${probe}" | sed -n 1p) in ${TOOLS_IMAGE} (${WHY})" >&2
run() {
    "${DOCKER}" run --rm --label ai-agent=true ${NETWORK[@]+"${NETWORK[@]}"} "${MOUNTS[@]}" -w "${REPO_ROOT}" \
        -e MICA_BUILD_DOCKER=docker ${ENV[@]+"${ENV[@]}"} -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
        "${TOOLS_IMAGE}" bun "$@"
}
! needs_install || run install --frozen-lockfile >&2
exec "${DOCKER}" run --rm --label ai-agent=true ${NETWORK[@]+"${NETWORK[@]}"} "${MOUNTS[@]}" -w "${REPO_ROOT}" \
    -e MICA_BUILD_DOCKER=docker ${ENV[@]+"${ENV[@]}"} -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    "${TOOLS_IMAGE}" bun "$@"
