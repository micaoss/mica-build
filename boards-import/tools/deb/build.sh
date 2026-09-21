#!/usr/bin/env bash
# Build one producer's Debian packages for one architecture. Every producer is
# built by this driver and no other.
#
#   bash tools/deb/build.sh --producer board@cx3576 --arch arm64
#   bash tools/deb/build.sh --producer radio-wifi --arch all
#
#   -> _out/debs/<arch>/pool/<package>_<version>_<arch>.deb
#      (MICA_POOL_DIR=<dir> writes <dir>/<arch>/pool instead)
#
# Packaging runs at the target architecture through buildx; anything that is
# not packaging runs in the producer's PREPARE hook on the host. The packer
# image is the mica-build-env base image (locks/mica-build-env.lock); the producer
# convention is tools/deb/README.md.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
FROM_SH="${REPO_ROOT}/tools/from.sh"
PRODUCERS_SH="${HERE}/producers.sh"
for p in "${REPO_ROOT}/Makefile" "${FROM_SH}" "${PRODUCERS_SH}"; do
    [ -e "${p}" ] || {
        echo "error: ${p} does not exist. tools/deb/build.sh derives the repository as two levels above itself; if this file moved, that arithmetic moved with it" >&2
        exit 1
    }
done

command -v docker >/dev/null 2>&1 || {
    echo "error: docker is required and not on PATH. The packaging runs in a container -- the host carries no dpkg -- which is what makes the packer a value build-env-image.lock records" >&2
    exit 1
}

PRODUCER=""
ARCH=""
while [ "$#" -gt 0 ]; do
    case "$1" in
    --producer)
        PRODUCER="${2-}"
        [ -n "${PRODUCER}" ] || { echo "error: --producer takes a producer name" >&2; exit 1; }
        shift 2
        ;;
    --arch)
        ARCH="${2-}"
        [ -n "${ARCH}" ] || { echo "error: --arch takes amd64, arm64 or all" >&2; exit 1; }
        shift 2
        ;;
    *)
        echo "usage: bash tools/deb/build.sh --producer <name> --arch <amd64|arm64|all>" >&2
        exit 1
        ;;
    esac
done
[ -n "${PRODUCER}" ] || { echo "error: --producer is required; there is no default producer, because a build that picked one would package a subset nobody asked for" >&2; exit 1; }
[ -n "${ARCH}" ] || { echo "error: --arch is required; guessing the host's would silently produce amd64 packages for a cx3576 image" >&2; exit 1; }

PRODUCER_REL="$(bash "${PRODUCERS_SH}" --dir-for "${PRODUCER}")"
PRODUCER_DIR="${REPO_ROOT}/${PRODUCER_REL}"
PRODUCER_ENV="${PRODUCER_DIR}/producer.env"
# A matrix producer's instance (<producer>@<instance>): the FOR_EACH file's
# assignments are in the environment before producer.env is sourced, so its
# values can name the instance, and the hook and the Dockerfile are told
# which instance they build (MICA_DEB_INSTANCE, MICA_DEB_INSTANCE_ENV).
INSTANCE="${PRODUCER#*@}"; [ "${INSTANCE}" != "${PRODUCER}" ] || INSTANCE=""
INSTANCE_ENV="$(bash "${PRODUCERS_SH}" --instance-for "${PRODUCER}")"
if [ -n "${INSTANCE_ENV}" ]; then
    INSTANCE_ENV="${REPO_ROOT}/${INSTANCE_ENV}"
    while IFS= read -r line; do
        case "${line}" in
        '' | '#'*) continue ;;
        *'$('* | *'`'*) echo "error: ${INSTANCE_ENV#"${REPO_ROOT}"/} carries a command substitution: ${line}; an instance file is plain KEY=value" >&2; exit 1 ;;
        esac
        [[ "${line}" =~ ^[A-Z][A-Z0-9_]*= ]] || { echo "error: ${INSTANCE_ENV#"${REPO_ROOT}"/} carries a line that is neither KEY=value nor a comment: ${line}" >&2; exit 1; }
    done <"${INSTANCE_ENV}"
    # shellcheck disable=SC1090
    . "${INSTANCE_ENV}"
fi

# producer.env must be plain KEY=value before it is sourced.
while IFS= read -r line; do
    case "${line}" in
    '' | '#'*) continue ;;
    esac
    case "${line}" in
    *'$('* | *'`'*)
        echo "error: ${PRODUCER_REL}/producer.env carries a command substitution: ${line}. This file DESCRIBES a producer and is sourced by this driver; logic in it runs at build time in whatever context the caller had" >&2
        exit 1
        ;;
    esac
    [[ "${line}" =~ ^[A-Z][A-Z0-9_]*= ]] || {
        echo "error: ${PRODUCER_REL}/producer.env carries a line that is neither KEY=value nor a comment: ${line}. Plain assignments only -- see tools/deb/README.md" >&2
        exit 1
    }
done <"${PRODUCER_ENV}"

# Cleared so the environment cannot stand in for an undeclared key.
PACKAGES=""
ARCHES=""
BUILD_CONTEXTS=""
FROM_IMAGES=""
BUILD_ARGS=""
PREPARE=""
PREPARE_INPUTS=""
# shellcheck disable=SC1091
. "${PRODUCER_ENV}"

in_arches=0
for a in ${ARCHES}; do [ "${a}" != "${ARCH}" ] || in_arches=1; done
[ "${in_arches}" = 1 ] || {
    echo "error: the producer '${PRODUCER}' declares ARCHES='${ARCHES}' and was asked for --arch ${ARCH}. That architecture is not one it builds; ${PRODUCER_REL}/producer.env is where that list lives" >&2
    exit 1
}

# The declared version and SOURCE_DATE_EPOCH (version.env beside the control
# templates): nothing about the checkout -- its commit, its time, a dirty tree
# -- reaches the archive, so a version names one set of bytes for good.
read -r VERSION SOURCE_DATE_EPOCH < <(bash "${PRODUCERS_SH}" --version-for "${PRODUCER}") && [ -n "${SOURCE_DATE_EPOCH:-}" ] || {
    echo "error: tools/deb/producers.sh --version-for ${PRODUCER} named no version (see its message above)" >&2
    exit 1
}

# Provenance for pack.sh: the origin basename unless MICA_SOURCE_REPO is set.
if [ -n "${MICA_SOURCE_REPO:-}" ]; then
    SOURCE_REPO="${MICA_SOURCE_REPO}"
else
    origin_url="$(git -C "${REPO_ROOT}" remote get-url origin 2>/dev/null || true)"
    SOURCE_REPO="$(basename "${origin_url%/}" .git)"
    [ -n "${origin_url}" ] && [ -n "${SOURCE_REPO}" ] || {
        echo "error: ${REPO_ROOT} has no 'origin' remote, so the archive's Mica-Source-Repo cannot be derived. Set MICA_SOURCE_REPO=<repository name> to say which repository this checkout is" >&2
        exit 1
    }
fi
[[ "${SOURCE_REPO}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
    echo "error: the source repository name '${SOURCE_REPO}' (from ${MICA_SOURCE_REPO:+MICA_SOURCE_REPO}${MICA_SOURCE_REPO:-origin}) is not a plain repository name" >&2
    exit 1
}

case "$(uname -m)" in
x86_64) HOST_ARCH=amd64 ;;
aarch64 | arm64) HOST_ARCH=arm64 ;;
*)
    echo "error: $(uname -m) is not an architecture the build-env images carry (amd64, arm64), so there is no container to pack in" >&2
    exit 1
    ;;
esac

# An `all` archive has no ELF: built once at the host architecture and exported
# to both pools from that one build.
if [ "${ARCH}" = all ]; then
    DEB_ARCH=all
    BUILD_PLATFORM="${HOST_ARCH}"
    POOL_ARCHES=(amd64 arm64)
else
    DEB_ARCH="${ARCH}"
    BUILD_PLATFORM="${ARCH}"
    POOL_ARCHES=("${ARCH}")
fi

# A small staging directory under the worktree, visible to the docker daemon.
STAGE="${REPO_ROOT}/tmp/deb-${PRODUCER}-${ARCH}"
rm -rf "${STAGE}"
mkdir -p "${STAGE}"

# The PREPARE hook: runs on the host; what it leaves in ${MICA_DEB_STAGE} is the `bin` context.
if [ -n "${PREPARE}" ]; then
    # A file name beside producer.env, never a path.
    case "${PREPARE}" in
    */*)
        echo "error: ${PRODUCER_REL}/producer.env names PREPARE=${PREPARE}, which is a path. A hook is a file name beside the producer.env that declares it" >&2
        exit 1
        ;;
    esac
    hook="${PRODUCER_DIR}/${PREPARE}"
    [ -f "${hook}" ] || {
        echo "error: ${PRODUCER_REL}/producer.env names PREPARE=${PREPARE} and ${PRODUCER_REL}/${PREPARE} does not exist. The hook is the producer's own half of its build; a named one that is absent means the payload is never produced and the pack below would stage nothing" >&2
        exit 1
    }
    echo "build.sh: ${PRODUCER} running PREPARE hook ${PRODUCER_REL}/${PREPARE} for ${ARCH}"
    MICA_DEB_REPO_ROOT="${REPO_ROOT}" \
        MICA_DEB_PRODUCER="${PRODUCER}" \
        MICA_DEB_PRODUCER_DIR="${PRODUCER_DIR}" \
        MICA_DEB_INSTANCE="${INSTANCE}" \
        MICA_DEB_INSTANCE_ENV="${INSTANCE_ENV}" \
        MICA_DEB_ARCH="${ARCH}" \
        MICA_DEB_STAGE="${STAGE}" \
        MICA_DEB_VERSION="${VERSION}" \
        SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH}" \
        bash "${hook}"
    [ -n "$(ls -A "${STAGE}")" ] || {
        echo "error: the PREPARE hook ${PRODUCER_REL}/${PREPARE} reported success and left ${STAGE} empty. That directory is the 'bin' build context this producer's Dockerfile copies from" >&2
        exit 1
    }
fi

# Builder: BUILDX_BUILDER if set, else `default` when it reaches the platform,
# else the `mica-<arch>` docker-container builder. Never the ambient selection.
if [ -n "${BUILDX_BUILDER:-}" ]; then
    echo "note: using the builder BUILDX_BUILDER names (${BUILDX_BUILDER})"
    BUILDER="${BUILDX_BUILDER}"
else
    # Captured, not piped into an early-exiting reader (pipefail).
    default_platforms="$(docker buildx inspect default 2>/dev/null || true)"
    if [ "${#POOL_ARCHES[@]}" -eq 1 ] && printf '%s\n' "${default_platforms}" | grep -c "linux/${BUILD_PLATFORM}" >/dev/null; then
        BUILDER=default
    else
        # The docker driver accepts one output, so an `all` producer needs a container builder.
        BUILDER="mica-${BUILD_PLATFORM}"
        docker buildx inspect "${BUILDER}" >/dev/null 2>&1 ||
            docker buildx create --name "${BUILDER}" --driver docker-container >/dev/null
    fi
fi

builder_inspect="$(docker buildx inspect "${BUILDER}" 2>/dev/null || true)"
BUILDER_DRIVER="$(printf '%s\n' "${builder_inspect}" | sed -n 's/^Driver:[[:space:]]*//p')"
[ -n "${BUILDER_DRIVER}" ] || {
    echo "error: \`docker buildx inspect ${BUILDER}\` names no driver: the builder does not exist or is not running (\`docker buildx ls\` lists what does)" >&2
    exit 1
}
if [ "${BUILDER_DRIVER}" = docker ] &&
    ! printf '%s\n' "${builder_inspect}" | grep -c "linux/${BUILD_PLATFORM}" >/dev/null; then
    echo "error: the buildx builder '${BUILDER}' uses the docker driver and does not offer linux/${BUILD_PLATFORM} on this host, so pack.sh would fail with 'exec format error'. Build on a ${BUILD_PLATFORM} host (CI runs one job per architecture), or unset BUILDX_BUILDER and let this script select the docker-container builder 'mica-${BUILD_PLATFORM}'" >&2
    exit 1
fi
if [ "${BUILDER_DRIVER}" = docker ] && [ "${#POOL_ARCHES[@]}" -gt 1 ]; then
    echo "error: the buildx builder '${BUILDER}' uses the docker driver, which accepts one --output per build, and the producer '${PRODUCER}' is Architecture: all and writes ${#POOL_ARCHES[@]} pools from one build. Unset BUILDX_BUILDER and let this script select the docker-container builder" >&2
    exit 1
fi

# The container's architecture; the host's for an `all` producer.
IMAGE_ARCH="${BUILD_PLATFORM}"

# The packer image is always supplied (MICA_BUILD_BASE); FROM_IMAGES adds
# further bases as <build-arg name>=mica-build-env:<image> or <build-arg name>=upstream:<name>.
FROM_ENTRIES=("MICA_BUILD_BASE=mica-build-env:base")
for entry in ${FROM_IMAGES}; do
    case "${entry}" in
    MICA_BUILD_BASE=*) FROM_ENTRIES[0]="${entry}" ;;
    *) FROM_ENTRIES+=("${entry}") ;;
    esac
done

FROM_ARGS=()
for entry in "${FROM_ENTRIES[@]}"; do
    argname="${entry%%=*}"
    key="${entry#*=}"
    [ -n "${argname}" ] && [ -n "${key}" ] && [ "${argname}" != "${entry}" ] || {
        echo "error: ${PRODUCER_REL}/producer.env declares FROM_IMAGES entry '${entry}', which is not <build-arg name>=mica-build-env:<image> or <build-arg name>=upstream:<name>" >&2
        exit 1
    }
    mapfile -t got < <(bash "${FROM_SH}" "${argname}=${key}")
    [ "${#got[@]}" -eq 2 ] || {
        echo "error: tools/from.sh did not resolve ${argname}=${key} (see its message above)" >&2
        exit 1
    }
    FROM_ARGS+=("${got[@]}")
done

# pack.sh as the `packer` context, so edits apply without rebuilding the images.
CTX_ARGS=(--build-context "packer=${HERE}")
[ -z "${PREPARE}" ] || CTX_ARGS+=(--build-context "bin=${STAGE}")
for entry in ${BUILD_CONTEXTS}; do
    name="${entry%%=*}"
    path="${entry#*=}"
    [ -n "${name}" ] && [ -n "${path}" ] && [ "${name}" != "${entry}" ] || {
        echo "error: ${PRODUCER_REL}/producer.env declares BUILD_CONTEXTS entry '${entry}', which is not <context name>=<repository-relative path>" >&2
        exit 1
    }
    [ -d "${REPO_ROOT}/${path}" ] || {
        echo "error: ${PRODUCER_REL}/producer.env declares the build context '${name}=${path}', which is not a directory under ${REPO_ROOT}. buildx would resolve a missing local context as a remote one and fail naming neither" >&2
        exit 1
    }
    CTX_ARGS+=(--build-context "${name}=${REPO_ROOT}/${path}")
done

ARG_ARGS=(
    --build-arg "MICA_DEB_VERSION=${VERSION}"
    --build-arg "MICA_DEB_ARCH=${DEB_ARCH}"
    --build-arg "SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH}"
    --build-arg "MICA_DEB_SOURCE_REPO=${SOURCE_REPO}"
    --build-arg "MICA_DEB_INSTANCE=${INSTANCE}"
)
for entry in ${BUILD_ARGS}; do
    # KEY=VALUE only: a bare KEY would take its value from the caller's environment.
    case "${entry}" in
    *=*) ARG_ARGS+=(--build-arg "${entry}") ;;
    *)
        echo "error: ${PRODUCER_REL}/producer.env declares BUILD_ARGS entry '${entry}', which is not KEY=VALUE" >&2
        exit 1
        ;;
    esac
done

# The pool is shared: remove only this producer's previous archives.
POOL_ROOT="${MICA_POOL_DIR:-${REPO_ROOT}/_out/debs}"
OUT_ARGS=()
for pool_arch in "${POOL_ARCHES[@]}"; do
    pool="${POOL_ROOT}/${pool_arch}/pool"
    mkdir -p "${pool}"
    for p in ${PACKAGES}; do
        rm -f "${pool}/${p}"_*.deb
    done
    OUT_ARGS+=(-o "type=local,dest=${pool}")
done

echo "build.sh: packing ${PACKAGES} ${VERSION} as ${DEB_ARCH} from ${SOURCE_REPO} at SOURCE_DATE_EPOCH ${SOURCE_DATE_EPOCH} on builder '${BUILDER}' (${BUILDER_DRIVER}) into ${POOL_ARCHES[*]}"
docker buildx build --builder "${BUILDER}" \
    --platform "linux/${BUILD_PLATFORM}" \
    "${FROM_ARGS[@]}" \
    "${CTX_ARGS[@]}" \
    "${ARG_ARGS[@]}" \
    -f "${PRODUCER_DIR}/Dockerfile" \
    "${OUT_ARGS[@]}" \
    "${PRODUCER_DIR}"

EXPORTED=()
for pool_arch in "${POOL_ARCHES[@]}"; do
    for p in ${PACKAGES}; do
        EXPORTED+=("${POOL_ROOT}/${pool_arch}/pool/${p}_${VERSION}_${DEB_ARCH}.deb")
    done
done

# The archives are already exported, so a refusal withdraws this run's whole
# output from the pool rather than leaving it for repo.sh to index.
reject() {
    rm -f "${EXPORTED[@]}"
    echo "error: $* -- and the ${#EXPORTED[@]} archive(s) this run exported have been removed from the pool, because a package this driver refused must not be left where repo.sh would index it. There is now no archive for ${PACKAGES}; rebuild once the cause is fixed" >&2
    exit 1
}

missing=""
for deb in "${EXPORTED[@]}"; do
    [ -f "${deb}" ] || missing="${missing} ${deb#"${POOL_ROOT}"/}"
done
[ -z "${missing}" ] || reject "the export is missing:${missing}"

# Both exports of an `all` build must be the same bytes.
if [ "${#POOL_ARCHES[@]}" -gt 1 ]; then
    first="${POOL_ARCHES[0]}"
    for p in ${PACKAGES}; do
        for pool_arch in "${POOL_ARCHES[@]:1}"; do
            a="${POOL_ROOT}/${first}/pool/${p}_${VERSION}_${DEB_ARCH}.deb"
            b="${POOL_ROOT}/${pool_arch}/pool/${p}_${VERSION}_${DEB_ARCH}.deb"
            cmp -s "${a}" "${b}" ||
                reject "${p} was exported to the ${first} and ${pool_arch} pools from ONE build and the two archives differ. An Architecture: all package is one archive that is a member of every pool"
        done
    done
fi

# ENABLEMENT is checked by package-gate.sh over the whole pool, not here.

rm -rf "${STAGE}"
for pool_arch in "${POOL_ARCHES[@]}"; do
    for p in ${PACKAGES}; do
        echo "${POOL_ROOT}/${pool_arch}/pool/${p}_${VERSION}_${DEB_ARCH}.deb"
    done
done
