#!/usr/bin/env bash
# tools/pool.sh against fixture locks: the happy path of a published and an
# offline lock, and every refusal by name.
#
#   bash tests/pool-test.sh          (make os-pool-test; docker)
#
# The network is a `curl` on PATH that answers the ghcr.io token, manifest and
# blob endpoints from a fixture tree. pool.sh is run unchanged with
# MICA_LOCKS_DIR, MICA_POOL_DIR, MICA_POOL_CACHE and MICA_OCI_CACHE pointed at
# the scratch tree (with the build-env lock of this tree, for the images), so
# each case perturbs one input and requires the refusal that names it.
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
https://ghcr.io/token\?*) file="${POOL_TEST_FIXTURES}/token.json" ;;
https://ghcr.io/v2/*) file="${POOL_TEST_FIXTURES}/${url#https://ghcr.io/v2/}" ;;
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

# --- the archives: fixture-a (amd64) of fixture-a, fixture-base (all) of fixture-base.
COMMIT_A="$(printf 'a%.0s' $(seq 40))"
COMMIT_BASE="$(printf 'b%.0s' $(seq 40))"
V_A="1.0.0+git${COMMIT_A:0:12}-1"
V_BASE="20260914-0000-1"
mkdir -p "${SCRATCH}/debs"
# mica-build-side: container-block -- the fixture archives are packed by dpkg-deb in mica-build-env:base.
docker run --rm --label ai-agent=true --network none -v "${SCRATCH}/debs:/out" \
    -e "V_A=${V_A}" -e "V_BASE=${V_BASE}" -e "COMMIT_A=${COMMIT_A}" -e "COMMIT_BASE=${COMMIT_BASE}" \
    "$(bash tools/from.sh --ref mica-build-env:base)" bash -c '
    set -euo pipefail
    pack() { # name version repo commit version-on-disk arch file
        mkdir -p "/tmp/$1/DEBIAN"
        printf "Package: %s\nVersion: %s\nArchitecture: %s\nMaintainer: test <test@invalid>\nDescription: fixture\nMica-Source-Repo: %s\nMica-Source-Commit: %s\n" "$1" "$5" "$6" "$3" "$4" >"/tmp/$1/DEBIAN/control"
        dpkg-deb --root-owner-group -Zgzip --build "/tmp/$1" "/out/$7" >/dev/null
        rm -rf "/tmp/$1"
    }
    pack fixture-a "${V_A}" fixture-a "${COMMIT_A}" "${V_A}" amd64 a.deb
    pack fixture-a "${V_A}" fixture-a "${COMMIT_A}" "9.9.9+git${COMMIT_A:0:12}-1" amd64 a-wrong.deb
    pack fixture-base "${V_BASE}" fixture-base "${COMMIT_BASE}" "${V_BASE}" all base.deb
    pack fixture-base "${V_BASE}" fixture-base "$(printf "c%.0s" $(seq 40))" "${V_BASE}" all base-other.deb
    chmod 0644 /out/*.deb'
# mica-build-side: host
D0="$(printf '0%.0s' $(seq 64))"

# pool_manifest <file> <repository> <commit> <arch> [<deb> <title>]...
pool_manifest() {
    local file="$1" repository="$2" commit="$3" arch="$4" layers="[]"
    shift 4
    while [ "$#" -gt 0 ]; do
        layers="$(jq -c --arg d "sha256:$(sha "$1")" --arg t "$2" --argjson n "$(stat -c %s "$1")" '. + [{mediaType: "application/vnd.mica.deb", digest: $d, size: $n, annotations: {"org.opencontainers.image.title": $t}}]' <<<"${layers}")"
        shift 2
    done
    jq -n --arg r "${repository}" --arg c "${commit}" --arg a "${arch}" --argjson l "${layers}" '{schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/vnd.mica.pool", config: {mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2}, layers: $l, annotations: {"mica.source-repo": $r, "mica.source-commit": $c, "org.opencontainers.image.revision": $c, "mica.arch": $a}}' >"${file}"
}

# A fresh scratch tree: the published blobs and manifests, and the locks naming them.
setup() {
    rm -rf "${FIX}/micaoss" "${SCRATCH}/locks" "${SCRATCH}/pool" "${SCRATCH}/cache" "${SCRATCH}/manifests" "${SCRATCH}/checkout"
    mkdir -p "${SCRATCH}/locks/pins" "${SCRATCH}/manifests"
    # The build-env images the control fields are read in.
    cp locks/mica-build-env.lock "${SCRATCH}/locks/"; cp locks/pins/mica-build-env.pin "${SCRATCH}/locks/pins/"
    printf '{"token":"fixture"}\n' >"${FIX}/token.json"
    local r
    for r in fixture-a fixture-base; do mkdir -p "${FIX}/micaoss/${r}/manifests" "${FIX}/micaoss/${r}/blobs"; done
    cp "${SCRATCH}/debs/a.deb" "${FIX}/micaoss/fixture-a/blobs/sha256:$(sha "${SCRATCH}/debs/a.deb")"
    cp "${SCRATCH}/debs/base.deb" "${FIX}/micaoss/fixture-base/blobs/sha256:$(sha "${SCRATCH}/debs/base.deb")"
    pool_manifest "${SCRATCH}/manifests/fixture-a-amd64.json" fixture-a "${COMMIT_A}" amd64 "${SCRATCH}/debs/a.deb" "fixture-a_${V_A}_amd64.deb"
    pool_manifest "${SCRATCH}/manifests/fixture-a-arm64.json" fixture-a "${COMMIT_A}" arm64
    for arch in amd64 arm64; do
        pool_manifest "${SCRATCH}/manifests/fixture-base-${arch}.json" fixture-base "${COMMIT_BASE}" "${arch}" "${SCRATCH}/debs/base.deb" "fixture-base_${V_BASE}_all.deb"
    done
    A_SHA="$(sha "${SCRATCH}/debs/a.deb")"; BASE_SHA="$(sha "${SCRATCH}/debs/base.deb")"
    publish
}
# publish: every manifest under its digest, and the locks and pins naming those digests.
publish() {
    local r arch digest
    rm -f "${FIX}"/micaoss/*/manifests/*
    for r in fixture-a fixture-base; do
        for arch in amd64 arm64; do
            digest="sha256:$(sha "${SCRATCH}/manifests/${r}-${arch}.json")"
            cp "${SCRATCH}/manifests/${r}-${arch}.json" "${FIX}/micaoss/${r}/manifests/${digest}"
            eval "POOL_${r//-/_}_${arch}=ghcr.io/micaoss/${r}:pool.${arch}.20260914-0000@${digest}"
        done
    done
    lock fixture-a "${COMMIT_A}" "${POOL_fixture_a_amd64}" "${POOL_fixture_a_arm64}" "package	fixture-a	amd64	${V_A}	${A_SHA}"
    lock fixture-base "${COMMIT_BASE}" "${POOL_fixture_base_amd64}" "${POOL_fixture_base_arm64}" "package	fixture-base	amd64	${V_BASE}	${BASE_SHA}
package	fixture-base	arm64	${V_BASE}	${BASE_SHA}"
}
# lock <repository> <commit> <amd64 pool> <arm64 pool> <package rows>
lock() {
    printf '# mica-lock v1\nrelease\t%s\t20260914-0000\t%s\npool\tamd64\t%s\npool\tarm64\t%s\n%s\n' "$1" "$2" "$3" "$4" "$5" >"${SCRATCH}/locks/$1.lock"
    printf '# mica-pin v1\nREPOSITORY=%s\nRELEASE=20260914-0000\nSHA256SUMS=%s\n' "$1" "${D0}" >"${SCRATCH}/locks/pins/$1.pin"
}

pool() {
    PATH="${SHIM}:${PATH}" POOL_TEST_FIXTURES="${FIX}" MICA_LOCKS_DIR="${SCRATCH}/locks" \
        MICA_POOL_DIR="${SCRATCH}/pool" MICA_POOL_CACHE="${SCRATCH}/cache" MICA_OCI_CACHE="${SCRATCH}/cache/oci" bash tools/pool.sh "$@"
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

# 1. Two locks: verified into the pool, then indexed.
setup
if out="$(pool fetch --arch amd64 2>&1)"; then
    [ -f "${SCRATCH}/pool/amd64/pool/fixture-a_${V_A}_amd64.deb" ] && [ -f "${SCRATCH}/pool/amd64/pool/fixture-base_${V_BASE}_all.deb" ] &&
        pass "fetch verifies the archives of both locks into the pool" || fail "fetch succeeded without writing both archives: ${out}"
else
    fail "fetch of valid fixtures was refused: ${out}"
fi
if out="$(pool index --arch amd64 2>&1)" && [ "$(grep -c '^Package: ' "${SCRATCH}/pool/amd64/Packages")" -eq 2 ]; then
    pass "index writes Packages over both archives"
else
    fail "index: ${out}"
fi
if [ "$(pool rows --arch arm64 | cut -f1,3,5)" = "fixture-base	all	fixture-base" ]; then
    pass "rows reads the architecture out of the layer title: an all archive, one row per pool"
else
    fail "rows --arch arm64: $(pool rows --arch arm64 2>&1)"
fi

# 2. --check reads the manifests and downloads nothing.
setup
if out="$(pool fetch --arch amd64 --check 2>&1)" && [ -z "$(find "${SCRATCH}/cache" -name '*.deb' 2>/dev/null)" ] && [ ! -d "${SCRATCH}/pool" ]; then
    pass "--check confirms both archives and downloads nothing"
else
    fail "--check: ${out}"
fi

# 3. The pool manifest.
setup
edit_json "${SCRATCH}/manifests/fixture-a-amd64.json" '.annotations["mica.source-commit"] = "'"$(printf 'c%.0s' $(seq 40))"'"'
publish
expect_refusal "a pool manifest whose commit is not the release row's" "is not the amd64 pool of fixture-a at ${COMMIT_A}" fetch --arch amd64 --packages fixture-a

setup
edit_json "${SCRATCH}/manifests/fixture-a-amd64.json" '.artifactType = "application/vnd.oci.image.config.v1+json"'
publish
expect_refusal "a manifest that is not a mica pool" "is not the amd64 pool of fixture-a" fetch --arch amd64 --packages fixture-a

setup
edit_json "${SCRATCH}/manifests/fixture-a-amd64.json" '.layers[0].annotations["org.opencontainers.image.title"] = "fixture-a.deb"'
publish
expect_refusal "a layer titled other than the row's archive" "is titled fixture-a.deb" fetch --arch amd64 --packages fixture-a

setup
A_SHA="${D0}"
publish
expect_refusal "a package row that is no layer of its pool" "carries no archive layer sha256:${D0}" fetch --arch amd64 --packages fixture-a

setup
digest="${POOL_fixture_a_amd64##*@}"
printf '{}\n' >"${FIX}/micaoss/fixture-a/manifests/${digest}"
expect_refusal "a registry serving other bytes for the digest" "served a manifest for ${digest} with other bytes" fetch --arch amd64 --packages fixture-a

setup
rm "${FIX}/token.json"
expect_refusal "no pull token" "the token endpoint of ghcr.io answered 404" fetch --arch amd64 --packages fixture-a

# 4. The archive.
setup
cp "${SCRATCH}/debs/base-other.deb" "${FIX}/micaoss/fixture-base/blobs/sha256:${BASE_SHA}"
expect_refusal "a registry serving other archive bytes" "served a blob for sha256:${BASE_SHA} with other bytes" fetch --arch amd64 --packages fixture-base

setup
rm "${FIX}/micaoss/fixture-a/blobs/sha256:${A_SHA}"
expect_refusal "a missing archive, with no fallback" "answered 404" fetch --arch amd64 --packages fixture-a

setup
cp "${SCRATCH}/debs/a-wrong.deb" "${FIX}/micaoss/fixture-a/blobs/sha256:$(sha "${SCRATCH}/debs/a-wrong.deb")"
A_SHA="$(sha "${SCRATCH}/debs/a-wrong.deb")"
pool_manifest "${SCRATCH}/manifests/fixture-a-amd64.json" fixture-a "${COMMIT_A}" amd64 "${SCRATCH}/debs/a-wrong.deb" "fixture-a_${V_A}_amd64.deb"
publish
expect_refusal "an archive whose control fields are not the row" "locks/ says fixture-a ${V_A} amd64" fetch --arch amd64 --packages fixture-a

setup
cp "${SCRATCH}/debs/base-other.deb" "${FIX}/micaoss/fixture-base/blobs/sha256:$(sha "${SCRATCH}/debs/base-other.deb")"
BASE_SHA="$(sha "${SCRATCH}/debs/base-other.deb")"
for arch in amd64 arm64; do
    pool_manifest "${SCRATCH}/manifests/fixture-base-${arch}.json" fixture-base "${COMMIT_BASE}" "${arch}" "${SCRATCH}/debs/base-other.deb" "fixture-base_${V_BASE}_all.deb"
done
publish
expect_refusal "an archive of another commit than its release" "locks/ says fixture-base ${COMMIT_BASE}" fetch --arch amd64 --packages fixture-base

# 5. The locks themselves.
setup
sed -i 's|ghcr.io/micaoss/fixture-a:pool.amd64|ghcr.io/other/fixture-a:pool.amd64|' "${SCRATCH}/locks/fixture-a.lock"
expect_refusal "a lock naming another registry" "reference-registry ghcr.io/other/fixture-a" rows
setup
rm "${SCRATCH}/locks/pins/fixture-a.pin"
expect_refusal "a lock without its pin" "refused lock-without-pin" rows
setup
expect_refusal "a package with no row" "no amd64 package row for fixture-none" fetch --arch amd64 --packages fixture-none
setup
pool_manifest "${SCRATCH}/manifests/fixture-a-amd64.json" fixture-a "${COMMIT_A}" amd64 "${SCRATCH}/debs/a.deb" "fixture-a_${V_A}_amd64.deb" "${SCRATCH}/debs/base.deb" "fixture-base_${V_BASE}_all.deb"
digest="sha256:$(sha "${SCRATCH}/manifests/fixture-a-amd64.json")"
cp "${SCRATCH}/manifests/fixture-a-amd64.json" "${FIX}/micaoss/fixture-a/manifests/${digest}"
lock fixture-a "${COMMIT_A}" "ghcr.io/micaoss/fixture-a:pool.amd64.20260914-0000@${digest}" "${POOL_fixture_a_arm64}" "package	fixture-a	amd64	${V_A}	${A_SHA}
package	fixture-base	amd64	${V_BASE}	${BASE_SHA}"
expect_refusal "one package in two locks" "fixture-base is pinned twice for all" rows

# 6. An offline lock (tools/local-pins.sh): its pool is read out of the checkout's OCI layout, never in CI.
offline_setup() {
    setup
    local layout="${SCRATCH}/checkout/_out/offline/oci" digest
    mkdir -p "${layout}/blobs/sha256"
    cp "${SCRATCH}/debs/a.deb" "${layout}/blobs/sha256/${A_SHA}"
    for arch in amd64 arm64; do
        digest="$(sha "${SCRATCH}/manifests/fixture-a-${arch}.json")"
        cp "${SCRATCH}/manifests/fixture-a-${arch}.json" "${layout}/blobs/sha256/${digest}"
        eval "OFFLINE_${arch}=local/fixture-a:pool.${arch}.offline@sha256:${digest}"
    done
    printf '# mica-lock v1\nrelease\tfixture-a\toffline\t%s\npool\tamd64\t%s\npool\tarm64\t%s\npackage\tfixture-a\tamd64\t%s\t%s\n' "${COMMIT_A}" "${OFFLINE_amd64}" "${OFFLINE_arm64}" "${V_A}" "${A_SHA}" >"${SCRATCH}/locks/fixture-a.lock"
    printf '# mica-pin v1\nREPOSITORY=fixture-a\nRELEASE=offline\nSHA256SUMS=%s\nCHECKOUT=%s\n' "${D0}" "${SCRATCH}/checkout" >"${SCRATCH}/locks/pins/fixture-a.pin"
}
offline_setup
if out="$(CI='' GITHUB_ACTIONS='' pool fetch --arch amd64 --packages fixture-a 2>&1)" && [ -f "${SCRATCH}/pool/amd64/pool/fixture-a_${V_A}_amd64.deb" ]; then
    pass "an offline lock reads the checkout's OCI layout"
else
    fail "an offline lock: ${out}"
fi
offline_setup
GITHUB_ACTIONS=true expect_refusal "an offline pin under GitHub Actions" "refused checkout-in-ci" fetch --arch amd64 --packages fixture-a
offline_setup
rm "${SCRATCH}/checkout/_out/offline/oci/blobs/sha256/${A_SHA}"
CI='' GITHUB_ACTIONS='' expect_refusal "an offline layout without the archive" "holds no blob sha256:${A_SHA}" fetch --arch amd64 --packages fixture-a

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
