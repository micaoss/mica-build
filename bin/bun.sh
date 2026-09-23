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
# The first argument names a module of the tree (src/cli.ts) by its tree-relative path; it is resolved against
# the root here, and every argument after it means what it means in the caller's directory, on both routes --
# the boards' Makefiles hand relative paths from boards/<board>/.
case "${1:-}" in
/* | '') ;;
*) [ ! -e "${REPO_ROOT}/$1" ] || set -- "${REPO_ROOT}/$1" "${@:2}" ;;
esac
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
    exec "${BUN}" "$@"
fi

# --- the container route ---
# The container runs as root -- the tree's tests set ownership and capabilities in their fixture roots
# (lchown, security.capability), which no other user may -- and everything it created in the tree as root
# is handed to this host user when the command ends (the epilogue below), so the next host-side step that
# needs it is not refused. The scratch directories are created here, so that they exist before the first
# command looks for them. Measured: CI run 35746126641, where the pool cache created inside
# (_out/cache/oci, root's) refused the host's mkdir of _out/cache/pool beside it, one level below the
# directories this line pre-creates; and run 35749459944, where a container running AS the host user
# failed 79 fixture tests on lchown and a sibling container's root-owned output.
mkdir -p "${REPO_ROOT}/.tmp" "${REPO_ROOT}/tmp" "${REPO_ROOT}/_out" "${REPO_ROOT}/.work"
# The git inside is root and the tree is this host user's: every directory is safe. Said in a global
# configuration file rather than as GIT_CONFIG_* variables, because the remote side of a local `git clone`
# (a test's scratch clone of the tree) reads only protected configuration and takes the variables for
# none; measured in the tools image (git 2.47) over a tree owned by uid 1001, CI run 35853107043.
printf '[safe]\n\tdirectory = *\n' >"${REPO_ROOT}/.tmp/gitconfig"
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
# tree's resolver (src/cli.ts from runs the lock reader through this script, so a host with no bun would
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
# The docker client's configuration directory, where buildx keeps its builder instances and a login its
# credentials: mounted at its own path, so the client inside is the client on this host -- a builder the
# package gate creates here is the one src/pool/build.ts builds on inside, and one created inside outlives
# the container. Measured before this existed: a rebuild inside on a builder created on the host found
# `docker buildx inspect` naming no driver.
DOCKER_CONFIG_DIR="${DOCKER_CONFIG:-${HOME}/.docker}"
HANDED=("${REPO_ROOT}/.tmp" "${REPO_ROOT}/tmp" "${REPO_ROOT}/_out" "${REPO_ROOT}/.work" "${REPO_ROOT}/node_modules")
if [ -d "${DOCKER_CONFIG_DIR}" ]; then
    MOUNTS+=(-v "$(host_path "${DOCKER_CONFIG_DIR}"):${DOCKER_CONFIG_DIR}" -e "DOCKER_CONFIG=${DOCKER_CONFIG_DIR}")
    HANDED+=("${DOCKER_CONFIG_DIR}")
fi
# The epilogue: what the command left in the scratch directories -- and in the docker client's configuration
# directory, where buildx inside records its activity -- as root becomes the host user's (a no-op for root,
# the only owner there is). Only root-owned entries are touched, so what a sibling container wrote as root
# (a pool index, a composed root) is handed over too. The exit status is bun's. Measured before the
# configuration directory was handed over: CI run 35752739496, where the host's buildx found
# ~/.docker/buildx/activity/default root's after a build inside.
if [ "$(id -u)" = 0 ]; then
    EPILOGUE='exec bun "$@"'
else
    EPILOGUE="bun \"\$@\"; rc=\$?; chown -R --from=0 $(id -u):$(id -g) ${HANDED[*]} 2>/dev/null; exit \$rc"
fi
# The harness network, when this host has it (the suites attach their containers to it); a job that never
# created it runs on the default network, which is enough for the commands that only read the tree.
NETWORK=()
! "${DOCKER}" network inspect traefik >/dev/null 2>&1 || NETWORK=(--network traefik)
PREFLIGHT=("${REPO_ROOT}/package.json" "${REPO_ROOT}/src/cli.ts")
# An offline pin names a checkout outside the tree (locks/pins/*.pin CHECKOUT=); its _out/offline layout is read
# inside (src/pool/oci.ts, a local/ reference), so it is mounted read-only at its own path. Writing one (local-pins)
# needs bun on the host, and says so.
for d in $(awk -F= '/^CHECKOUT=/ { print $2 }' "${REPO_ROOT}"/locks/pins/*.pin 2>/dev/null | sort -u); do
    [ -d "${d}" ] || continue
    case "${d}/" in "${REPO_ROOT}/"*) continue ;; esac
    MOUNTS+=(-v "$(host_path "${d}"):${d}:ro"); PREFLIGHT+=("${d}")
done
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
# reader's CI mode, which the pool gate (tests/gates/pool.test.ts) sets and clears), BUILDX_BUILDER and
# BUILDKIT_PROGRESS (the package gate rebuilds a producer on an empty-cache builder of its own, through
# src/pool/build.ts), and every MICA_* variable but the three that steer this bootstrap. A variable set to
# the empty string crosses as empty, which is what a test that clears it means. Measured before this
# existed: CI run 35725871542, where an offline pin under GitHub Actions was not refused, because inside
# the container nothing said it was GitHub Actions.
ENV=()
while IFS= read -r name; do
    case "${name}" in MICA_BUN|MICA_BUN_CONTAINER|MICA_BUILD_DOCKER) continue ;; esac
    ENV+=(-e "${name}")
done < <(env | sed -n 's/^\(CI\|GITHUB_ACTIONS\|GH_TOKEN\|GITHUB_TOKEN\|BUILDX_BUILDER\|BUILDKIT_PROGRESS\|MICA_[A-Za-z0-9_]*\)=.*/\1/p')
# Announced to a terminal only: a caller that captures the command's output, stderr included, must not be
# able to tell which route it got (tests/gates/release-test.sh compares a plan's combined output; CI run
# 35728952530 showed it the announcement instead).
[ ! -t 2 ] || echo "bin/bun.sh: bun $(printf '%s\n' "${probe}" | sed -n 1p) in ${TOOLS_IMAGE} (${WHY})" >&2
# The working directory inside is the caller's when it is under the tree (the boards' Makefiles hand relative
# paths from boards/<board>/), and the root otherwise: a relative path means the same on both routes.
WORKDIR="${REPO_ROOT}"
case "${PWD}" in "${REPO_ROOT}" | "${REPO_ROOT}"/*) WORKDIR="${PWD}" ;; esac
run() {
    "${DOCKER}" run --rm --label ai-agent=true ${NETWORK[@]+"${NETWORK[@]}"} "${MOUNTS[@]}" -w "${WORKDIR}" \
        -e MICA_BUILD_DOCKER=docker -e MICA_BUN_ROUTE=container ${ENV[@]+"${ENV[@]}"} -e "GIT_CONFIG_GLOBAL=${REPO_ROOT}/.tmp/gitconfig" \
        "${TOOLS_IMAGE}" sh -c "${EPILOGUE}" sh "$@"
}
! needs_install || run install --frozen-lockfile >&2
exec "${DOCKER}" run --rm --label ai-agent=true ${NETWORK[@]+"${NETWORK[@]}"} "${MOUNTS[@]}" -w "${WORKDIR}" \
    -e MICA_BUILD_DOCKER=docker -e MICA_BUN_ROUTE=container ${ENV[@]+"${ENV[@]}"} -e "GIT_CONFIG_GLOBAL=${REPO_ROOT}/.tmp/gitconfig" \
    "${TOOLS_IMAGE}" sh -c "${EPILOGUE}" sh "$@"
