#!/usr/bin/env bash
# tools/pool.sh against fixture releases: the happy path of both transports and
# every refusal by name.
#
#   bash tests/pool-test.sh          (make os-pool-test; docker)
#
# The network is a `curl` on PATH that answers from a fixture tree: GitHub
# release downloads, and the ghcr.io token, manifest and blob endpoints. pool.sh
# is run unchanged with MICA_LOCK_DIR, MICA_RELEASE_DIR, MICA_POOL_DIR,
# MICA_POOL_CACHE, MICA_SYSTEM_BASE_LOCK and MICA_OCI_CACHE pointed at the
# scratch tree, so each case perturbs one input and requires the refusal that
# names it.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SCRATCH="${REPO_ROOT}/tmp/pool-test.$$"
mkdir -p "${SCRATCH}"
trap 'rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

FIX="${SCRATCH}/fixtures"
SHIM="${SCRATCH}/bin"
mkdir -p "${FIX}" "${SHIM}"

# --- the network: URL -> fixture file, answering 200 or 404.
cat >"${SHIM}/curl" <<'CURL'
#!/usr/bin/env bash
set -euo pipefail
out=""; fmt=""; url=""
while [ "$#" -gt 0 ]; do
    case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) fmt="$2"; shift 2 ;;
    -H | --max-time) shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
    esac
done
case "${url}" in
https://github.com/*/releases/download/*) file="${POOL_TEST_FIXTURES}/gh/${url#https://github.com/}" ;;
https://ghcr.io/token\?*) file="${POOL_TEST_FIXTURES}/oci/token.json" ;;
https://ghcr.io/v2/*) file="${POOL_TEST_FIXTURES}/oci/${url#https://ghcr.io/v2/}" ;;
*) file="" ;;
esac
code=404
if [ -n "${file}" ] && [ -f "${file}" ]; then
    code=200
    if [ -n "${out}" ]; then cp "${file}" "${out}"; else cat "${file}"; fi
fi
[ -z "${fmt}" ] || printf '%s' "${code}"
CURL
chmod 0755 "${SHIM}/curl"

# --- two archives: one per transport.
COMMIT_GH="$(printf 'a%.0s' $(seq 40))"
COMMIT_OCI="$(printf 'b%.0s' $(seq 40))"
V_GH="1.0.0+git${COMMIT_GH:0:12}-1"
V_OCI="20260914-0000-1"
mkdir -p "${SCRATCH}/debs"
# mica-build-side: container-block -- the fixture archives are packed by dpkg-deb in IMAGE_MICA_BUILD_BASE.
docker run --rm --label ai-agent=true --network none -v "${SCRATCH}/debs:/out" \
    -e "V_GH=${V_GH}" -e "V_OCI=${V_OCI}" -e "COMMIT_GH=${COMMIT_GH}" -e "COMMIT_OCI=${COMMIT_OCI}" \
    "$(bash tools/from.sh --ref IMAGE_MICA_BUILD_BASE)" bash -c '
    set -euo pipefail
    pack() { # name version repo commit version-on-disk arch [file]
        mkdir -p "/tmp/$1/DEBIAN"
        printf "Package: %s\nVersion: %s\nArchitecture: %s\nMaintainer: test <test@invalid>\nDescription: fixture\nMica-Source-Repo: %s\nMica-Source-Commit: %s\n" "$1" "$5" "$6" "$3" "$4" >"/tmp/$1/DEBIAN/control"
        dpkg-deb --root-owner-group -Zgzip --build "/tmp/$1" "/out/${7:-$1_$2_$6.deb}" >/dev/null
        rm -rf "/tmp/$1"
    }
    pack fixture-gh "${V_GH}" fixture-gh "${COMMIT_GH}" "${V_GH}" amd64
    pack fixture-base "${V_OCI}" mica-system-base "${COMMIT_OCI}" "${V_OCI}" all
    pack fixture-base "${V_OCI}" mica-system-base "$(printf "c%.0s" $(seq 40))" "${V_OCI}" all fixture-base-other.deb
    pack fixture-gh-wrong "${V_GH}" fixture-gh "${COMMIT_GH}" "9.9.9+git${COMMIT_GH:0:12}-1" amd64
    chmod 0644 /out/*.deb'
# mica-build-side: host
DEB_GH="${SCRATCH}/debs/fixture-gh_${V_GH}_amd64.deb"
DEB_OCI="${SCRATCH}/debs/fixture-base_${V_OCI}_all.deb"
DEB_OCI_OTHER="${SCRATCH}/debs/fixture-base-other.deb"
DEB_WRONG="${SCRATCH}/debs/fixture-gh-wrong_${V_GH}_amd64.deb"
ASSET_GH="fixture-gh_${V_GH//+/.}_amd64.deb"
ASSET_OCI="fixture-base_${V_OCI}_all.deb"
BASE="micaoss/mica-system-base"

# Build a fresh scratch tree: pins, release records and published fixtures.
setup() {
    rm -rf "${FIX}/gh" "${FIX}/oci" "${SCRATCH}/pins" "${SCRATCH}/releases" "${SCRATCH}/pool" "${SCRATCH}/cache"
    mkdir -p "${FIX}/gh/micaoss/fixture-gh/releases/download/20260914-0000" "${SCRATCH}/pins" "${SCRATCH}/releases"
    local rel="${FIX}/gh/micaoss/fixture-gh/releases/download/20260914-0000"
    cp "${DEB_GH}" "${rel}/${ASSET_GH}"
    printf '%s  %s\n' "$(sha "${DEB_GH}")" "${ASSET_GH}" >"${rel}/SHA256SUMS"
    jq -n --arg c "${COMMIT_GH}" --arg s "$(sha "${rel}/SHA256SUMS")" '{repository: "fixture-gh", release: "20260914-0000", commit: $c, transport: "github-release", url: "https://github.com/micaoss/fixture-gh/releases/download/20260914-0000/", sha256sums: $s}' >"${SCRATCH}/releases/fixture-gh.json"
    jq -n --arg c "${COMMIT_GH}" --arg v "${V_GH}" --arg s "$(sha "${DEB_GH}")" --arg a "${ASSET_GH}" '{name: "fixture-gh", repository: "fixture-gh", commit: $c, targets: {amd64: {version: $v, architecture: "amd64", sha256: $s, asset: $a}}}' >"${SCRATCH}/pins/fixture-gh.json"

    local arch layer
    mkdir -p "${FIX}/oci/${BASE}/manifests" "${FIX}/oci/${BASE}/blobs"
    printf '{"token":"fixture"}\n' >"${FIX}/oci/token.json"
    layer="$(sha "${DEB_OCI}")"
    cp "${DEB_OCI}" "${FIX}/oci/${BASE}/blobs/sha256:${layer}"
    for arch in amd64 arm64; do
        jq -n --arg c "${COMMIT_OCI}" --arg a "${arch}" --arg l "sha256:${layer}" --arg t "${ASSET_OCI}" --argjson n "$(stat -c %s "${DEB_OCI}")" '{schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/vnd.mica.pool", config: {mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2}, layers: [{mediaType: "application/vnd.mica.deb", digest: $l, size: $n, annotations: {"org.opencontainers.image.title": $t}}], annotations: {"mica.source-repo": "mica-system-base", "mica.source-commit": $c, "org.opencontainers.image.revision": $c, "mica.arch": $a}}' >"${SCRATCH}/manifest-${arch}.json"
    done
    publish_manifests
}
# The pool manifests under their digests, and the lock naming those digests.
publish_manifests() {
    local d0 amd64 arm64
    d0="sha256:$(printf '0%.0s' $(seq 64))"
    rm -f "${FIX}/oci/${BASE}/manifests/"*
    amd64="sha256:$(sha "${SCRATCH}/manifest-amd64.json")"
    arm64="sha256:$(sha "${SCRATCH}/manifest-arm64.json")"
    cp "${SCRATCH}/manifest-amd64.json" "${FIX}/oci/${BASE}/manifests/${amd64}"
    cp "${SCRATCH}/manifest-arm64.json" "${FIX}/oci/${BASE}/manifests/${arm64}"
    {
        echo "IMAGE_MICA_SYSTEM_BASE_ROOTFS=ghcr.io/${BASE}:rootfs.20260914-0000@${d0}"
        echo "IMAGE_MICA_SYSTEM_BASE_ROOTFS_AMD64=ghcr.io/${BASE}@${d0}"
        echo "IMAGE_MICA_SYSTEM_BASE_ROOTFS_ARM64=ghcr.io/${BASE}@${d0}"
        echo "POOL_MICA_SYSTEM_BASE_AMD64=ghcr.io/${BASE}:pool.amd64.20260914-0000@${amd64}"
        echo "POOL_MICA_SYSTEM_BASE_ARM64=ghcr.io/${BASE}:pool.arm64.20260914-0000@${arm64}"
    } >"${SCRATCH}/system-base.lock"
}

pool() {
    PATH="${SHIM}:${PATH}" POOL_TEST_FIXTURES="${FIX}" MICA_LOCK_DIR="${SCRATCH}/pins" MICA_RELEASE_DIR="${SCRATCH}/releases" \
        MICA_POOL_DIR="${SCRATCH}/pool" MICA_POOL_CACHE="${SCRATCH}/cache" \
        MICA_SYSTEM_BASE_LOCK="${SCRATCH}/system-base.lock" MICA_OCI_CACHE="${SCRATCH}/cache/oci" bash tools/pool.sh "$@"
}
# expect_refusal <label> <fragment> <pool.sh args...>
expect_refusal() {
    local label="$1" fragment="$2" out
    shift 2
    if out="$(pool "$@" 2>&1)"; then
        fail "${label}: pool.sh succeeded"
    elif printf '%s' "${out}" | grep -F -- "${fragment}" >/dev/null; then
        pass "${label}: refused naming '${fragment}'"
    else
        fail "${label}: refused, but not naming '${fragment}': ${out}"
    fi
}
edit_json() { # <file> <jq filter>
    jq "$2" "$1" >"$1.new" && mv "$1.new" "$1"
}

# 1. Both transports: verified into the pool, then indexed.
setup
if out="$(pool fetch --arch amd64 2>&1)"; then
    [ -f "${SCRATCH}/pool/amd64/pool/fixture-gh_${V_GH}_amd64.deb" ] && [ -f "${SCRATCH}/pool/amd64/pool/fixture-base_${V_OCI}_all.deb" ] &&
        pass "fetch verifies both transports into the pool" || fail "fetch succeeded without writing both archives: ${out}"
else
    fail "fetch of valid fixtures was refused: ${out}"
fi
if out="$(pool index --arch amd64 2>&1)" && [ "$(grep -c '^Package: ' "${SCRATCH}/pool/amd64/Packages")" -eq 2 ]; then
    pass "index writes Packages over both archives"
else
    fail "index: ${out}"
fi

# 2. --check reads the listings and downloads nothing.
setup
if out="$(pool fetch --arch amd64 --check 2>&1)" && [ -z "$(find "${SCRATCH}/cache" -name '*.deb' 2>/dev/null)" ] && [ ! -d "${SCRATCH}/pool" ]; then
    pass "--check confirms both archives and downloads nothing"
else
    fail "--check: ${out}"
fi

# 3. github-release refusals.
setup
edit_json "${SCRATCH}/releases/fixture-gh.json" '.sha256sums = "'"$(printf '0%.0s' $(seq 64))"'"'
expect_refusal "a SHA256SUMS other than the recorded one" "records $(printf '0%.0s' $(seq 64))" fetch --arch amd64 --packages fixture-gh

setup
rel="${FIX}/gh/micaoss/fixture-gh/releases/download/20260914-0000"
printf '%s  %s\n' "$(printf 'f%.0s' $(seq 64))" "${ASSET_GH}" >"${rel}/SHA256SUMS"
edit_json "${SCRATCH}/releases/fixture-gh.json" ".sha256sums = \"$(sha "${rel}/SHA256SUMS")\""
expect_refusal "an asset listed at another digest" "is not listed at" fetch --arch amd64 --packages fixture-gh

setup
cp "${DEB_OCI}" "${FIX}/gh/micaoss/fixture-gh/releases/download/20260914-0000/${ASSET_GH}"
expect_refusal "published bytes other than the pinned digest" "hashes to other bytes" fetch --arch amd64 --packages fixture-gh

setup
rm "${FIX}/gh/micaoss/fixture-gh/releases/download/20260914-0000/${ASSET_GH}"
expect_refusal "a missing asset, with no fallback" "answered 404" fetch --arch amd64 --packages fixture-gh

setup
edit_json "${SCRATCH}/releases/fixture-gh.json" ".commit = \"$(printf 'c%.0s' $(seq 40))\""
expect_refusal "a release of another commit than the pins" "the pins of fixture-gh name commit" fetch --arch amd64 --packages fixture-gh

setup
edit_json "${SCRATCH}/releases/fixture-gh.json" '.url = "https://example.com/fixture/"'
expect_refusal "a release url that is not a GitHub release" "is not a github-release record" fetch --arch amd64 --packages fixture-gh

# 4. The control fields must be the pin.
setup
rel="${FIX}/gh/micaoss/fixture-gh/releases/download/20260914-0000"
cp "${DEB_WRONG}" "${rel}/${ASSET_GH}"
printf '%s  %s\n' "$(sha "${DEB_WRONG}")" "${ASSET_GH}" >"${rel}/SHA256SUMS"
edit_json "${SCRATCH}/releases/fixture-gh.json" ".sha256sums = \"$(sha "${rel}/SHA256SUMS")\""
edit_json "${SCRATCH}/pins/fixture-gh.json" ".targets.amd64.sha256 = \"$(sha "${DEB_WRONG}")\""
expect_refusal "an archive whose control fields are not the pin" "the pin says fixture-gh ${V_GH} amd64" fetch --arch amd64 --packages fixture-gh

# 5. Base lock refusals.
setup
edit_json "${SCRATCH}/manifest-amd64.json" '.annotations["mica.source-commit"] = "'"$(printf 'c%.0s' $(seq 40))"'"'
publish_manifests
expect_refusal "a pool manifest whose commit is not its revision" "is not the amd64 pool of mica-system-base" fetch --arch amd64 --packages fixture-base

setup
edit_json "${SCRATCH}/manifest-arm64.json" '.annotations["mica.source-commit"] = "'"$(printf 'c%.0s' $(seq 40))"'" | .annotations["org.opencontainers.image.revision"] = "'"$(printf 'c%.0s' $(seq 40))"'"'
publish_manifests
expect_refusal "two pools of one release naming two commits" "one release has one commit" fetch --arch amd64 --packages fixture-base

setup
edit_json "${SCRATCH}/manifest-amd64.json" '.artifactType = "application/vnd.oci.image.config.v1+json"'
publish_manifests
expect_refusal "a manifest that is not a mica pool" "is not the amd64 pool of mica-system-base" fetch --arch amd64 --packages fixture-base

setup
edit_json "${SCRATCH}/manifest-amd64.json" '.layers[0].annotations["org.opencontainers.image.title"] = "fixture-base.deb"'
publish_manifests
expect_refusal "a layer whose title is not an archive name" "whose title is not" fetch --arch amd64 --packages fixture-base

setup
cp "${DEB_OCI_OTHER}" "${FIX}/oci/${BASE}/blobs/sha256:$(sha "${DEB_OCI}")"
expect_refusal "a registry serving other archive bytes" "hashes to other bytes" fetch --arch amd64 --packages fixture-base

setup
layer="$(sha "${DEB_OCI_OTHER}")"
cp "${DEB_OCI_OTHER}" "${FIX}/oci/${BASE}/blobs/sha256:${layer}"
for arch in amd64 arm64; do
    edit_json "${SCRATCH}/manifest-${arch}.json" ".layers[0].digest = \"sha256:${layer}\""
done
publish_manifests
expect_refusal "an archive of another commit than its pool" "the pin says mica-system-base ${COMMIT_OCI}" fetch --arch amd64 --packages fixture-base

setup
digest="$(sed -n 's/^POOL_MICA_SYSTEM_BASE_AMD64=.*@//p' "${SCRATCH}/system-base.lock")"
printf '{}\n' >"${FIX}/oci/${BASE}/manifests/${digest}"
expect_refusal "a registry serving other bytes for the digest" "served a manifest for ${digest} with other bytes" fetch --arch amd64 --packages fixture-base

setup
rm "${FIX}/oci/token.json"
expect_refusal "no pull token" "the token endpoint of ghcr.io answered 404" fetch --arch amd64 --packages fixture-base

setup
sed -i 's/^POOL_MICA_SYSTEM_BASE_AMD64=ghcr.io\/micaoss\/mica-system-base:/POOL_MICA_SYSTEM_BASE_AMD64=ghcr.io\/micaoss\/other:/' "${SCRATCH}/system-base.lock"
expect_refusal "a lock naming another registry" "is not a ghcr.io/micaoss/mica-system-base reference" fetch --arch amd64 --packages fixture-base

# 6. The pins themselves.
setup
edit_json "${SCRATCH}/pins/fixture-gh.json" '.targets.amd64.asset = "other.deb"'
expect_refusal "a pin whose asset is not its archive name" "is not a package pin" rows
setup
expect_refusal "a package with no pin" "no amd64 pin for fixture-none" fetch --arch amd64 --packages fixture-none

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
