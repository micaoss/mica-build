#!/usr/bin/env bash
# What this tree reads out of the imported mica-podman archives.
#
#   bash tools/podman-pool.sh --refresh    deps/packages/mica-podman.versions.env from the pool's archives
#   bash tools/podman-pool.sh --check      the committed copy against both archives; the arm64 quadlet
#
#   reads   _out/debs/<arch>/pool/mica-podman_*.deb   (fetched at the pin by tools/pool.sh)
#   writes  deps/packages/mica-podman.versions.env     (--refresh)
#           _out/debs/arm64/mica-podman/quadlet        (--check)
#
# The container engine is built and released by micaoss/mica-podman; this
# repository imports the archives through deps/packages/mica-podman.json and
# never sees that repository's tree. Four of its consumers still need two
# things out of it: the versions the seven binaries were built from (the
# smoke register, the install-closure gate and the netavark kernel check
# compare what a binary reports against them) and the aarch64 quadlet
# binary (tests/quadlet-doc-test.sh runs the generator the image ships).
# The package carries the first as /usr/share/mica-podman/versions.env.
#
# THE VERSIONS FILE IS COMMITTED BESIDE THE PIN, not read out of the pool at
# test time, so that every offline suite has it and a checkout without a
# pool still says what the engine's versions are. It is a derived file:
# --refresh rewrites it from the archives after a lock bump, and --check --
# run by `make os-pool` -- refuses a copy that disagrees with what the two
# archives at the pin carry, so the copy cannot drift from the pin.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
POOL="${MICA_POOL_DIR:-${REPO_ROOT}/_out/debs}"
COPY="${REPO_ROOT}/deps/packages/mica-podman.versions.env"
MEMBER="${HERE}/deb-member.py"
VERSIONS_PATH="usr/share/mica-podman/versions.env"
QUADLET_PATH="usr/libexec/podman/quadlet"

archive_for() {
    local arch="$1" found=()
    for f in "${POOL}/${arch}/pool/"mica-podman_*_"${arch}".deb; do
        [ -e "${f}" ] && found+=("${f}")
    done
    [ "${#found[@]}" -eq 1 ] || {
        echo "error: expected exactly one mica-podman archive in ${POOL}/${arch}/pool, found ${#found[@]}. deps/packages/mica-podman.json pins it; fetch it with \`make os-pool\`" >&2
        exit 1
    }
    printf '%s\n' "${found[0]}"
}

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
for arch in amd64 arm64; do
    archive="$(archive_for "${arch}")"
    python3 "${MEMBER}" "${archive}" "${VERSIONS_PATH}" "${work}/${arch}.env"
done
cmp -s "${work}/amd64.env" "${work}/arm64.env" || {
    echo "error: the amd64 and arm64 mica-podman archives in ${POOL} carry different ${VERSIONS_PATH}; one pin cannot describe both. Re-pin mica-podman from one release" >&2
    diff -u "${work}/amd64.env" "${work}/arm64.env" >&2 || true
    exit 1
}

case "${1:-}" in
--refresh)
    cp "${work}/amd64.env" "${COPY}"
    echo "podman-pool.sh: ${COPY#"${REPO_ROOT}"/} rewritten from the archives at the pin; commit it beside deps/packages/mica-podman.json"
    ;;
--check)
    [ -f "${COPY}" ] || {
        echo "error: ${COPY} does not exist. It is the copy of ${VERSIONS_PATH} the offline suites read; write it with \`bash tools/podman-pool.sh --refresh\` and commit it beside the pin" >&2
        exit 1
    }
    cmp -s "${work}/amd64.env" "${COPY}" || {
        echo "error: ${COPY#"${REPO_ROOT}"/} is not the ${VERSIONS_PATH} the pinned mica-podman archives carry. The copy is derived from the pin; after a lock bump run \`bash tools/podman-pool.sh --refresh\` and commit both" >&2
        diff -u "${COPY}" "${work}/amd64.env" >&2 || true
        exit 1
    }
    python3 "${MEMBER}" "$(archive_for arm64)" "${QUADLET_PATH}" "${POOL}/arm64/mica-podman/quadlet"
    echo "podman-pool.sh: ${COPY#"${REPO_ROOT}"/} matches both archives at the pin; arm64 quadlet at ${POOL#"${REPO_ROOT}"/}/arm64/mica-podman/quadlet"
    ;;
*)
    echo "usage: bash tools/podman-pool.sh --refresh | --check" >&2
    exit 1
    ;;
esac
