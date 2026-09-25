#!/usr/bin/env bash
# Does a host with only Docker and git still build this tree? Run it and find out.
#
#   bash tests/suites/bare-host-gate/gate.sh          (or: make os-bare-host-gate)
#
# PLAN-080's criterion is "a host with only Docker and git must be able to build
# and release an image, completely", widened by its section 1 to the smallest
# set that runs anything here at all: docker, git, bash, make and a busybox
# userland. Its section 4 climbed that ladder BY HAND, once, on 2026-09-04 --
# and its section 9 then named the absence of a re-run as the record's own
# largest risk, in its own words: "nothing re-runs it, so the next path that
# requires a host tool will pass every check in section 6 and break the
# criterion". This is that climb, on demand. Backlog B6.
#
# THE CONSTRAINT IS THE WHOLE VALUE. Everything below runs inside
# upstream:docker:28-cli -- the image locks/mica-build-env.lock already lists for another
# reason, and the substrate section 4 used. No PATH trick on this host would do:
# a stripped PATH is a claim about a lookup, and the criterion is a claim about a
# machine. And the surface is MEASURED rather than trusted: substrate.sh asserts
# what the image carries before anything is added, and ladder.sh asserts that no
# producer in tests/gates/host-toolchain-lint.ts's table is reachable after.
#
# WHY bash AND make ARRIVE AS `apk add` AND NOT AS A DERIVED IMAGE. A derived
# image is a second thing that can gain content between the pin and the run,
# and it would move the one fact this gate exists to hold -- what is on the
# host -- into a Dockerfile nobody re-reads. Two packages, named on one line,
# added into the pinned image at run time, with the surface re-asserted
# afterwards: tests/suites/factory-root-gate/gate.sh does the same thing for the same
# reason. It costs a network fetch per run, which is stated here rather than
# discovered: this gate does not run offline.
#
# WHY A CLONE. Section 4 used one and the reason is not ceremony. This
# repository's working tree carries _out/ -- a rootfs, a package pool, compiled
# binaries, an apid UI bundle -- every byte of it produced by whatever the host
# had. A gate that mounted the working tree would be reading a machine's
# leftovers and calling them a criterion. It clones HEAD instead, so what is
# under test is what is committed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../../.." && pwd)"
for anchor in "${HERE}/substrate.sh" "${HERE}/ladder.sh" "${REPO}/src/locks/from.ts" "${REPO}/Makefile"; do
    [ -e "${anchor}" ] || {
        echo "error: ${anchor} does not exist." >&2
        echo "       This script computed HERE=${HERE} and REPO=${REPO} from its own location;" >&2
        echo "       either this directory moved and that arithmetic is stale, or the anchor did." >&2
        exit 1
    }
done

[ "$#" -eq 0 ] || {
    echo "error: '$1' is not an option this gate takes; it climbs one ladder and takes no arguments." >&2
    echo "       The ceiling is a decision recorded in tests/suites/bare-host-gate/ladder.sh, not a knob:" >&2
    echo "       a rung nobody can afford to run is a rung that gets turned off." >&2
    exit 1
}

# The two host tools the criterion itself names. Everything else this script
# uses -- rm, mkdir, sed -- is the busybox userland section 1 permits, and this
# script writes no byte of any artefact.
for t in docker git; do
    command -v "${t}" >/dev/null 2>&1 || {
        echo "error: ${t} is required and not on PATH. This gate proves that a host with docker and" >&2
        echo "       git can build this tree; it cannot prove it from a host with neither." >&2
        exit 1
    }
done

# Resolved before any container starts: a key that does not resolve is a
# question about locks/mica-build-env.lock, and answering it from inside a container
# nobody could start is two problems instead of one.
CLI_IMAGE="$(bash "${REPO}/bin/bun.sh" src/cli.ts from --ref upstream:docker:28-cli)" || exit 1
if ! docker image inspect "${CLI_IMAGE}" >/dev/null 2>&1; then
    echo "gate: ${CLI_IMAGE} is not in the local image store; pulling it"
    docker pull -q "${CLI_IMAGE}" >/dev/null 2>&1 || {
        echo "error: upstream:docker:28-cli=${CLI_IMAGE} could not be obtained." >&2
        echo "       That key is this tree's record of the docker client it pins, and this gate uses" >&2
        echo "       the image around it as the criterion's host. The reference is well formed --" >&2
        echo "       from.sh just checked that -- so what failed is the lookup: either no image has" >&2
        echo "       that digest, or this host cannot reach the registry." >&2
        exit 1
    }
fi

# The socket is MOUNTED, so it has to be a socket on this host, and the
# reasoning is bin/bun.sh src/cli.ts's verbatim: a DOCKER_HOST naming a TCP daemon is a
# different arrangement, and guessing which one a caller meant is how a run
# comes to talk to a daemon nobody chose.
case "${DOCKER_HOST:-}" in
"") DOCKER_SOCK=/var/run/docker.sock ;;
unix://*) DOCKER_SOCK="${DOCKER_HOST#unix://}" ;;
*)
    echo "error: DOCKER_HOST=${DOCKER_HOST} is not a unix:// socket, and this gate reaches the daemon" >&2
    echo "       by mounting its socket into the constrained container -- the criterion's host has" >&2
    echo "       docker, so the container standing in for it must have one that answers." >&2
    exit 1
    ;;
esac
[ -S "${DOCKER_SOCK}" ] || {
    echo "error: ${DOCKER_SOCK} is not a socket. The gate's first rung asks the daemon for its" >&2
    echo "       version, and a run that got past this would fail there with a message about a" >&2
    echo "       connection rather than about a mount." >&2
    exit 1
}

# UNDER _out/, AND THAT PATH IS LOAD-BEARING. Rung 3 runs bin/bun.sh src/cli.ts inside
# the constrained container, and bin/bun.sh src/cli.ts starts its bun container as a
# SIBLING with `-v ${REPO_ROOT}:${REPO_ROOT}`. A `-v` source is resolved by the
# daemon against the daemon's filesystem, not by the process asking -- PLAN-080
# section 4.3 is the bug that fact already caused here -- so the clone has to
# live at a path the daemon can see and be mounted at that same path. A
# container-local directory would resolve to an empty one, one level down, and
# the failure would arrive as a verify suite that could not find its own tree.
WORK="${REPO}/_out/bare-host-gate"
CLONE="${WORK}/mica"

HEAD_SHA="$(git -C "${REPO}" rev-parse HEAD)"
if [ -n "$(git -C "${REPO}" status --porcelain 2>/dev/null)" ]; then
    echo "gate: NOTE -- this working tree has uncommitted changes and the clone below does not."
    echo "gate:         What is under test is ${HEAD_SHA}, which is what a fresh host would get."
fi

rm -rf "${WORK}"
mkdir -p "${WORK}"

# --depth 1 over file://, not a plain local clone: a local one hardlinks the
# object store into a directory a root container is about to mount, and nothing
# below needs history. Measured on 2026-09-05: 27 MiB against 93 MiB, same HEAD,
# same 1104 tracked files. `git ls-files` and `git diff --diff-filter=U` are the
# only git the rungs use, and neither reads a commit.
echo "gate: cloning ${HEAD_SHA} into ${CLONE}"
git clone --quiet --depth 1 "file://${REPO}" "${CLONE}"
CLONE_SHA="$(git -C "${CLONE}" rev-parse HEAD)"
[ "${CLONE_SHA}" = "${HEAD_SHA}" ] || {
    echo "error: the clone is at ${CLONE_SHA} and this tree is at ${HEAD_SHA}." >&2
    echo "       A gate that reported on a commit nobody asked about would be worse than no gate." >&2
    exit 1
}

# One invocation shape for both rungs, so the two containers differ in exactly
# one thing -- whether bash and make have been added -- and nothing else can
# drift between them.
#
# GIT_CONFIG_* rather than a `git config --global` inside: the clone is owned by
# whoever ran this and the container is root, which is git's "dubious ownership"
# refusal on any host where those are not the same user. Passing it as
# environment leaves no state behind and touches nothing in the clone.
in_substrate() {
    docker run --rm \
        --label ai-agent=true \
        -v "${CLONE}:${CLONE}" \
        -v "${DOCKER_SOCK}:/var/run/docker.sock" \
        -w "${CLONE}" \
        -e GIT_CONFIG_COUNT=1 \
        -e GIT_CONFIG_KEY_0=safe.directory \
        -e "GIT_CONFIG_VALUE_0=${CLONE}" \
        -e "MICA_BARE_HOST_CLONE=${CLONE}" \
        --entrypoint /bin/sh \
        "${CLI_IMAGE}" -c "$1"
}

echo
echo "=== bare-host gate: ${CLI_IMAGE} ==="
echo "gate: rung 0 -- the substrate, before anything is added to it"
in_substrate "sh '${CLONE}/tests/suites/bare-host-gate/substrate.sh'"

echo
echo "gate: rungs 1-3 -- the same image plus bash and make, and nothing else"
# `apk add` writes into the container's own layer and it is discarded with it.
# -q so a package index does not bury the rungs; the assertion that the two
# arrived is ladder.sh's first act, so a silent failure here is still caught.
in_substrate "apk add --no-cache -q bash make && bash '${CLONE}/tests/suites/bare-host-gate/ladder.sh'"

echo
echo "BARE HOST GATE PASSED (${HEAD_SHA})"
echo "gate: the clone is left at ${CLONE}; the next run replaces it."
