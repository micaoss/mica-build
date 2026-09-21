#!/usr/bin/env bash
# Shared by tools/deb/publish.sh, tools/deb/version-guard.sh, tools/publish-components.sh and tools/reuse.sh: the registry
# declaration, the token, the OCI client (oci.sh), the release this checkout
# is and the origin-derived repository name. Sourced, not executed.
[ -n "${BASH_VERSION:-}" ] || { echo "registry.sh: bash only" >&2; exit 1; }

REGISTRY_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REGISTRY_REPO_ROOT="$(cd "${REGISTRY_HERE}/../.." && pwd)"
# Overridable so tests can drive a local registry.
REGISTRY_ENV="${MICA_REGISTRY_ENV:-${REGISTRY_HERE}/registry.env}"

# shellcheck disable=SC1091
. "${REGISTRY_HERE}/oci.sh"

# registry.env is checked to be plain KEY=value before it is sourced.
registry_load() {
    [ -f "${REGISTRY_ENV}" ] || { echo "error: ${REGISTRY_ENV} does not exist; it declares where artifacts are published" >&2; return 1; }
    while IFS= read -r line; do
        case "${line}" in
        '' | '#'*) continue ;;
        *'$('* | *'`'*) echo "error: ${REGISTRY_ENV} carries a command substitution: ${line}" >&2; return 1 ;;
        esac
        [[ "${line}" =~ ^[A-Z][A-Z0-9_]*= ]] || { echo "error: ${REGISTRY_ENV} carries a line that is neither KEY=value nor a comment: ${line}" >&2; return 1; }
    done <"${REGISTRY_ENV}"
    MICA_REGISTRY=""
    MICA_REGISTRY_USER=""
    MICA_RELEASE_TOKEN_VAR=""
    MICA_SOURCE_URL=""
    # shellcheck disable=SC1090
    . "${REGISTRY_ENV}"
    for v in MICA_REGISTRY MICA_REGISTRY_USER MICA_RELEASE_TOKEN_VAR MICA_SOURCE_URL; do
        [ -n "${!v}" ] || { echo "error: ${REGISTRY_ENV} declares no ${v}" >&2; return 1; }
    done
    oci_load || return 1
    command -v jq >/dev/null 2>&1 || { echo "error: jq is required to read the registry and not on PATH" >&2; return 1; }
}

# The token, from the variable registry.env names, else `gh auth token`,
# else none: a read needs no token; `registry_token --write` refuses without
# one. Never printed.
registry_token() {
    REGISTRY_TOKEN="${!MICA_RELEASE_TOKEN_VAR:-}"
    if [ -z "${REGISTRY_TOKEN}" ] && [ -z "${MICA_RELEASE_NO_GH:-}" ] && command -v gh >/dev/null 2>&1; then
        REGISTRY_TOKEN="$(gh auth token 2>/dev/null || true)"
    fi
    [ "${1:-}" != --write ] || [ -n "${REGISTRY_TOKEN}" ] || {
        echo "error: ${MICA_RELEASE_TOKEN_VAR} is unset or empty and \`gh auth token\` gave nothing. Publishing to ${OCI_HOST} needs a token with write:packages in that variable (tools/deb/registry.env names it); publishing is CI's, whose own token has it" >&2
        return 1
    }
}

# The release this checkout is: a clean tree whose HEAD carries the board's
# release tag <board>.<YYYYMMDD-HHMM> (created on GitHub by `gh release create`);
# a release is one board's. MICA_RELEASE_TAG (the release event's tag) names it,
# and must when HEAD carries several; the board must be in boards/boards.tsv.
# Sets RELEASE_LABEL (the tag <board>.<YYYYMMDD-HHMM>), RELEASE_BOARD, RELEASE_STAMP,
# RELEASE_COMMIT and RELEASE_CREATED (the commit date).
release_load() {
    [ -z "$(git -C "${REGISTRY_REPO_ROOT}" status --porcelain)" ] || {
        echo "error: ${REGISTRY_REPO_ROOT} has uncommitted changes; only a clean checkout of a release is published" >&2
        return 1
    }
    RELEASE_COMMIT="$(git -C "${REGISTRY_REPO_ROOT}" rev-parse HEAD)"
    RELEASE_CREATED="$(git -C "${REGISTRY_REPO_ROOT}" show -s --format=%cI HEAD)"
    local tags
    tags="$(git -C "${REGISTRY_REPO_ROOT}" tag --points-at HEAD | grep -E '^[a-z0-9][a-z0-9-]*\.[0-9]{8}-[0-9]{4}$' || true)"
    [ -n "${tags}" ] || { echo "error: HEAD ${RELEASE_COMMIT:0:12} carries no release tag <board>.YYYYMMDD-HHMM; publishing runs only for a release (gh release create <board>.<YYYYMMDD-HHMM> --target <commit>)" >&2; return 1; }
    if [ -n "${MICA_RELEASE_TAG:-}" ]; then
        # A loop, not `printf | grep -q`: the reader exits at the first match and
        # the writer dies of SIGPIPE, which pipefail reports as a failed pipeline
        # -- the answer inverted exactly when the tag IS there.
        local tag found=""
        while IFS= read -r tag; do [ "${tag}" != "${MICA_RELEASE_TAG}" ] || found=1; done <<<"${tags}"
        [ -n "${found}" ] || {
            echo "error: the release event names ${MICA_RELEASE_TAG}, and HEAD carries $(printf '%s ' ${tags})" >&2
            return 1
        }
        RELEASE_LABEL="${MICA_RELEASE_TAG}"
    else
        [ "$(printf '%s\n' "${tags}" | grep -c .)" = 1 ] || { echo "error: HEAD ${RELEASE_COMMIT:0:12} carries several release tags ($(printf '%s ' ${tags})); MICA_RELEASE_TAG names the one to publish" >&2; return 1; }
        RELEASE_LABEL="${tags}"
    fi
    RELEASE_BOARD="${RELEASE_LABEL%.*}"
    RELEASE_STAMP="${RELEASE_LABEL##*.}"
    bash "${REGISTRY_REPO_ROOT}/tools/boards.sh" arch "${RELEASE_BOARD}" >/dev/null || return 1
}

# One board's pool for one architecture at one release:
# <owner>/<repo>:pool.<board>.<arch>.<YYYYMMDD-HHMM>.
pool_repo() { oci_repo "$1"; } # <repo>
pool_tag() { oci_tag pool "$1" "$2" "$3"; } # <board> <arch> <YYYYMMDD-HHMM>

# The annotations every artifact carries: the commit it was built from, when
# that commit was made, and which repository built it.
artifact_annotations() { # <repo-name> <commit> <created-iso> <release> <out.json>
    jq -n --arg repo "$1" --arg commit "$2" --arg created "$3" --arg version "$4" \
        --arg url "${MICA_SOURCE_URL%/}/$1" \
        '{"org.opencontainers.image.revision": $commit, "org.opencontainers.image.created": $created, "org.opencontainers.image.source": $url, "org.opencontainers.image.version": $version, "mica.source-repo": $repo, "mica.source-commit": $commit}' >"$5"
}

# The annotations of a pool manifest: only what does not change with the
# release (mica:docs/design/release-lock.md section 2).
pool_annotations() { # <repo-name> <arch> <out.json>
    jq -n --arg repo "$1" --arg arch "$2" '{"mica.source-repo": $repo, "mica.arch": $arch}' >"$3"
}

# Where the publishers leave the rows of the release lock (tools/release-lock.sh
# writes the lock from them): <dir>/pool.tsv (arch, tag, digest), <dir>/package.tsv
# (name, arch, version, sha256), <dir>/board.tsv (board, arch, tag, digest).
LOCK_ROWS="${MICA_LOCK_ROWS:-${REGISTRY_REPO_ROOT}/_out/release/rows}"

# The repository this checkout is: MICA_SOURCE_REPO, else the basename of
# origin -- the same rule tools/deb/build.sh writes into Mica-Source-Repo.
registry_repo_name() {
    if [ -n "${MICA_SOURCE_REPO:-}" ]; then
        REPO_NAME="${MICA_SOURCE_REPO}"
    else
        local origin_url
        origin_url="$(git -C "${REGISTRY_REPO_ROOT}" remote get-url origin 2>/dev/null || true)"
        REPO_NAME="$(basename "${origin_url%/}" .git)"
        [ -n "${origin_url}" ] && [ -n "${REPO_NAME}" ] || {
            echo "error: ${REGISTRY_REPO_ROOT} has no 'origin' remote, so the repository name cannot be derived; set MICA_SOURCE_REPO=<name>" >&2
            return 1
        }
    fi
    [[ "${REPO_NAME}" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || { echo "error: '${REPO_NAME}' is not a plain repository name" >&2; return 1; }
}
