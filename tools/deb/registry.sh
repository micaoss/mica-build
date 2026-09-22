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

# The release this checkout is: a clean tree whose HEAD carries the scoped
# release tag <scope>.<YYYYMMDD-HHMM> (created on GitHub by `gh release create`),
# the scope a board of boards/boards.tsv or a product of products/ (whose board
# is then the release's board). MICA_RELEASE_TAG (the release event's tag) names
# it, and must when HEAD carries several. Sets RELEASE_LABEL (the tag),
# RELEASE_SCOPE, RELEASE_BOARD, RELEASE_STAMP, RELEASE_COMMIT and RELEASE_CREATED
# (the commit date).
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
    RELEASE_SCOPE="${RELEASE_LABEL%.*}"
    RELEASE_STAMP="${RELEASE_LABEL##*.}"
    RELEASE_BOARD="$(scope_board "${RELEASE_SCOPE}")" || return 1
}

# The board of a scope: the scope itself when boards/boards.tsv lists it, else the
# BOARD of products/<scope>/product.env. A scope that is neither is refused.
scope_board() { # <scope>
    local board
    if bash "${REGISTRY_REPO_ROOT}/tools/boards.sh" list | grep -Fx -- "$1" >/dev/null; then
        printf '%s\n' "$1"
    elif [ -f "${REGISTRY_REPO_ROOT}/products/$1/product.env" ]; then
        board="$(sed -n 's/^BOARD=//p' "${REGISTRY_REPO_ROOT}/products/$1/product.env" | tr -d '"')"
        bash "${REGISTRY_REPO_ROOT}/tools/boards.sh" arch "${board}" >/dev/null || return 1
        printf '%s\n' "${board}"
    else
        echo "error: the scope $1 is neither a board of boards/boards.tsv nor a product of products/" >&2
        return 1
    fi
}

# The newest published release whose mica-build.lock carries a row of <kind> for
# <board> (a `board <board> <component>` row, or a `pool` row of the board's
# architecture published under pool.<board>.<arch>.<stamp>): a board-scoped
# release, or a product-scoped release of one of the board's products, since
# both publish the board's components and pool under their own tag. Sets
# LATEST_LABEL and LATEST_LOCK (the downloaded lock); returns 1 when no release
# carries one. The release being published (<skip>) is never the answer. Read
# anonymously from GitHub, or from MICA_RELEASE_LIST and MICA_RELEASE_DOWNLOAD
# (a test's file:// releases).
latest_lock_with() { # <work> board <board> <component> [<skip>] | <work> pool <board> <arch> [<skip>]
    local work="$1" kind="$2" board="$3" what="$4" skip="${5:-}" slug list download auth=() token label lock
    slug="${MICA_SOURCE_URL#https://github.com/}/${REPO_NAME}"
    list="${MICA_RELEASE_LIST:-https://api.github.com/repos/${slug}/releases?per_page=100}"
    download="${MICA_RELEASE_DOWNLOAD:-https://github.com/${slug}/releases/download}"
    # The listing is release metadata from the GitHub API, whose anonymous rate limit
    # is shared by every job on a runner's address: a token, when the workflow hands
    # it in (GITHUB_TOKEN, or GH_TOKEN as the publish step sets it), only raises
    # that limit. The locks and artifacts are read anonymously.
    token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
    case "${list}" in https://api.github.com/*) [ -z "${token}" ] || auth=(-H "Authorization: Bearer ${token}") ;; esac
    curl -fsSL "${auth[@]}" "${list}" -o "${work}/releases.json" || { echo "error: listing the releases of ${slug} failed" >&2; return 1; }
    # Newest stamp first, whatever the scope; the index releases mica.* carry no board rows and are skipped.
    jq -r --arg skip "${skip}" '[.[] | select(.draft == false and .tag_name != $skip and (.tag_name | test("^[a-z0-9][a-z0-9-]*\\.[0-9]{8}-[0-9]{4}$"))
        and (.tag_name | startswith("mica.") | not) and ([.assets[].name] | index("mica-build.lock")))]
        | map(.tag_name) | sort_by(split(".")[1]) | reverse | .[]' "${work}/releases.json" >"${work}/labels"
    while IFS= read -r label; do
        lock="${work}/${label}.lock"
        curl -fsSL "${download}/${label}/mica-build.lock" -o "${lock}" || { echo "error: downloading mica-build.lock of ${label} failed" >&2; return 1; }
        case "${kind}" in
        board) awk -F'\t' -v b="${board}" -v c="${what}" '$1 == "board" && $2 == b && $3 == c { f = 1 } END { exit !f }' "${lock}" || continue ;;
        pool) awk -F'\t' -v a="${what}" -v p="pool.${board}.${what}." '$1 == "pool" && $2 == a && index($3, ":" p) { f = 1 } END { exit !f }' "${lock}" || continue ;;
        *) echo "error: latest_lock_with: kind ${kind} is board or pool" >&2; return 1 ;;
        esac
        LATEST_LABEL="${label}"
        LATEST_LOCK="${lock}"
        return 0
    done <"${work}/labels"
    return 1
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
# origin -- the same rule src/pool/build.ts writes into Mica-Source-Repo.
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
