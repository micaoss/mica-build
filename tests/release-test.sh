#!/usr/bin/env bash
# tools/release.sh without a GitHub Release: the plan over fixture release history,
# the collection over a fixture product carrying the contract's signed deployment,
# and the publication into a local registry, each refusal by name.
#
#   bash tests/release-test.sh          (make os-release-test; docker)
#
# The registry is registry:3.1.1 from locks/mica-build-env.lock, a sibling
# container on the traefik network. attach (gh release upload) is not run here.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SCRATCH="${REPO_ROOT}/tmp/release-test.$$"
REGISTRY_NAME="ai-agent-mica-release-test-$$"
mkdir -p "${SCRATCH}"
trap 'docker rm -f "${REGISTRY_NAME}" >/dev/null 2>&1 || true; rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }
release() { bash tools/release.sh "$@"; }
# expect_refusal <label> <fragment> <release.sh args...>
expect_refusal() {
    local label="$1" fragment="$2" out
    shift 2
    if out="$(release "$@" 2>&1)"; then
        fail "${label}: release.sh succeeded"
    elif printf '%s' "${out}" | grep -F -- "${fragment}" >/dev/null; then
        pass "${label}: refused naming '${fragment}'"
    else
        fail "${label}: refused, but not naming '${fragment}': ${out}"
    fi
}

# --- 1. The plan: the scope's products, their generations and previous releases.
HISTORY="${SCRATCH}/history"
PREVIOUS="${HISTORY}/x64_20260914-2042"
mkdir -p "${PREVIOUS}"
cp tests/release-lock/vectors/lock/valid/mica-build.x64.lock "${PREVIOUS}/mica-build.lock"
(cd "${PREVIOUS}" && sha256sum mica-build.lock >SHA256SUMS)
K="$(printf 'b%.0s' $(seq 64))"; R="$(printf 'c%.0s' $(seq 64))"
export MICA_RELEASE_HISTORY="${HISTORY}"

if [ "$(release plan x64/20260916-0000)" = "x64-dev	x64	4	x64/20260914-2042	${K}	${R}
x64-prod	x64	2	-	-	-" ]; then
    pass "a board scope plans its released products, one generation above their previous release, and not its PUBLISH=0 product"
else
    fail "plan x64: $(release plan x64/20260916-0000 2>&1)"
fi
if [ "$(release plan virt-arm64-dev/20260916-0000)" = "virt-arm64-dev	virt-arm64	2	-	-	-" ]; then
    pass "a product scope plans that product, at generation 2 for its first release"
else
    fail "plan virt-arm64-dev: $(release plan virt-arm64-dev/20260916-0000 2>&1)"
fi
expect_refusal "a scope of only products that are never released" "holds only products that are never released (PUBLISH=0)" plan x64-minimal/20260916-0000
expect_refusal "an unscoped tag" "must be <scope>/<YYYYMMDD-HHMM>" plan 20260916-0000
expect_refusal "a scope that is no product or board" "neither a product nor the board of a product" plan nosuch/20260916-0000
mkdir -p "${HISTORY}/x64_20260916-0000" "${HISTORY}/x64_20260915-0000"
if [ "$(release plan x64-dev/20260916-0000 | cut -f3,4)" = "4	x64/20260914-2042" ]; then
    pass "the release being built and an earlier release with no asset (a failed run) are not previous releases"
else
    fail "plan past an empty release: $(release plan x64-dev/20260916-0000 2>&1)"
fi
printf 'partial\n' >"${HISTORY}/x64_20260915-0000/mica-x64-dev-20260915-0000.img"
expect_refusal "an earlier release with assets and no lock" "release x64/20260915-0000: SHA256SUMS does not list exactly its mica-build.lock" plan x64-dev/20260916-0000
rm -rf "${HISTORY}/x64_20260916-0000" "${HISTORY}/x64_20260915-0000"
expect_refusal "a release older than the previous one" "which is not earlier than 20260913-0000" plan x64-dev/20260913-0000
printf '0%.0s' $(seq 64) >"${PREVIOUS}/SHA256SUMS"
expect_refusal "a previous release whose SHA256SUMS does not list its lock" "SHA256SUMS does not list exactly its mica-build.lock" plan x64/20260916-0000
(cd "${PREVIOUS}" && sha256sum mica-build.lock >SHA256SUMS)

# --- 2. The collection: which update packages ship, against the previous identities, and the guard that
# refuses a kernel packed to other bytes from the same inputs. The contract's deployment, and variants of
# it for the previous release's archive, signed with a throwaway updates key.
PRODUCTS="${SCRATCH}/products"
OUT="${PRODUCTS}/x64-dev"
SIGNING="${SCRATCH}/signing"
mkdir -p "${OUT}/deployments" "${OUT}/kinds" "${OUT}/updates" "${SIGNING}/updates" "${SCRATCH}/fixtures"
# fixtures: the current descriptor, and previous-release archive heads (MICAUPD1, length, envelope).
# mica-build-side: container-block -- openssl and python3 run in mica-build-env:base.
FIXTURE_IDS="$(docker run -i --rm --label ai-agent=true --network none -v "${REPO_ROOT}/tests/component-contracts:/contracts:ro" \
    -v "${SCRATCH}/fixtures:/out" "$(bash tools/from.sh --ref mica-build-env:base)" bash -c \
    'openssl genpkey -algorithm ed25519 -out /out/updates.pem 2>/dev/null && openssl genpkey -algorithm ed25519 -out /out/other.pem 2>/dev/null && python3 - /contracts/envelope.json /out' <<'PY'
import base64, hashlib, json, subprocess, sys
golden, out = sys.argv[1], sys.argv[2]
canonical = lambda v: json.dumps(v, sort_keys=True, separators=(',', ':'))
payload = json.loads(base64.b64decode(json.load(open(golden))['envelope']['payload']))
def ident(component):
    content = {k: v for k, v in component.items() if k != 'id'}
    component['id'] = hashlib.sha256(canonical(content).encode()).hexdigest()
def envelope(deployment, key):
    body = canonical(deployment).encode()
    raw = subprocess.run(['openssl', 'pkey', '-in', f'{out}/{key}.pem', '-pubout', '-outform', 'DER'], capture_output=True, check=True).stdout[-32:]
    open(f'{out}/body', 'wb').write(body)
    signature = subprocess.run(['openssl', 'pkeyutl', '-sign', '-inkey', f'{out}/{key}.pem', '-rawin', '-in', f'{out}/body'], capture_output=True, check=True).stdout
    return json.dumps({'schema': 'mica/update-envelope/v1', 'keyId': hashlib.sha256(raw).hexdigest(),
                       'payload': base64.b64encode(body).decode(), 'signature': base64.b64encode(signature).decode()}, separators=(',', ':')), base64.b64encode(raw).decode()
def archive(name, deployment, key='updates'):
    text, _ = envelope(deployment, key)
    open(f'{out}/{name}.micaupd', 'wb').write(b'MICAUPD1' + len(text).to_bytes(4, 'big') + text.encode() + bytes(4))
text, public = envelope(payload, 'updates')
open(f'{out}/current.json', 'w').write(text)
open(f'{out}/public.key', 'w').write(public + '\n')
archive('same', payload)
rebuilt = json.loads(canonical(payload)); rebuilt['kernel']['buildId'] = 'f' * 64; ident(rebuilt['kernel']); archive('rebuilt', rebuilt)
repacked = json.loads(canonical(payload)); repacked['kernel']['boot']['artifact']['sha256'] = '5a' * 32; ident(repacked['kernel'])
assert repacked['kernel']['id'] != payload['kernel']['id'] != rebuilt['kernel']['id']; archive('repacked', repacked)
archive('other-key', payload, 'other')
print(payload['kernel']['id'], payload['rootfs']['id'], rebuilt['kernel']['id'], repacked['kernel']['id'])
PY
)"
# mica-build-side: host
read -r KERNEL ROOTFS K_REBUILT K_REPACKED <<<"${FIXTURE_IDS}"
cp "${SCRATCH}/fixtures/public.key" "${SIGNING}/updates/public.key"
cp "${SCRATCH}/fixtures/current.json" "${OUT}/deployments/1.json"
DEPLOYMENT="$(jq -r .deploymentId tests/component-contracts/cases.json)"
PREVIOUS_ARCHIVE="${PREVIOUS}/mica-x64-dev-20260914-2042.micaupd"
printf 'release 20260916-0000\ngeneration 1\n' >"${OUT}/receipt.txt"
product_file() { # <table> <kind> <file>
    printf '%s bytes\n' "$3" >"${OUT}/$3"
    printf '%s\t%s\t%s\n' "$2" "$3" "$(sha "${OUT}/$3")" >>"${OUT}/$1"
}
: >"${OUT}/kinds.tsv"; : >"${OUT}/updates.tsv"
product_file kinds.tsv disk kinds/mica-x64-dev-20260916-0000.img
cp "${OUT}/kinds/mica-x64-dev-20260916-0000.img" "${SCRATCH}/raw-disk.img"
product_file updates.tsv full updates/mica-x64-dev-20260916-0000.micaupd
product_file updates.tsv kernel updates/mica-x64-dev-20260916-0000.kernel.micaupd
product_file updates.tsv root updates/mica-x64-dev-20260916-0000.root.micaupd
collect() { # <plan line> <dir>
    printf '%s\n' "$1" >"${SCRATCH}/plan.tsv"
    MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" release collect x64-dev x64/20260916-0000 "${SCRATCH}/plan.tsv" "$2"
}
assets_of() { awk -F'\t' '$1 == "asset" { print $3 "/" $4 }' "$1/rows/x64-dev.tsv" | tr '\n' ' '; }

cp "${SCRATCH}/fixtures/same.micaupd" "${PREVIOUS_ARCHIVE}"
if collect "x64-dev	x64	1	x64/20260914-2042	${KERNEL}	${R}" "${SCRATCH}/root-only" >/dev/null 2>&1 &&
    [ "$(assets_of "${SCRATCH}/root-only")" = "image/disk update/full update/root " ] &&
    [ "$(grep $'^product\t' "${SCRATCH}/root-only/rows/x64-dev.tsv")" = "product	x64-dev	x64	dev	1	${DEPLOYMENT}	${KERNEL}	${ROOTFS}" ]; then
    pass "an unchanged kernel id ships the root package, and the product row is the signed deployment's"
else
    fail "collect with the previous kernel: $(collect "x64-dev	x64	1	x64/20260914-2042	${KERNEL}	${R}" "${SCRATCH}/root-only" 2>&1 | tail -3)"
fi
cp "${SCRATCH}/fixtures/rebuilt.micaupd" "${PREVIOUS_ARCHIVE}"
if collect "x64-dev	x64	1	x64/20260914-2042	${K_REBUILT}	${ROOTFS}" "${SCRATCH}/kernel-only" >/dev/null 2>&1 &&
    [ "$(assets_of "${SCRATCH}/kernel-only")" = "image/disk update/full update/kernel " ]; then
    pass "an unchanged rootfs id ships the kernel package, and a kernel of other inputs passes the guard"
else
    fail "collect with the previous rootfs: $(collect "x64-dev	x64	1	x64/20260914-2042	${K_REBUILT}	${ROOTFS}" "${SCRATCH}/kernel-only" 2>&1 | tail -2)"
fi
printf '%s\n' "x64-dev	x64	1	x64/20260914-2042	${K_REPACKED}	${ROOTFS}" >"${SCRATCH}/plan.tsv"
cp "${SCRATCH}/fixtures/repacked.micaupd" "${PREVIOUS_ARCHIVE}"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a kernel of the previous release's buildId packed to another id" \
    "equals release x64/20260914-2042's, and the kernel id ${KERNEL} differs" collect x64-dev x64/20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
printf '%s\n' "x64-dev	x64	1	x64/20260914-2042	${K}	${ROOTFS}" >"${SCRATCH}/plan.tsv"
cp "${SCRATCH}/fixtures/same.micaupd" "${PREVIOUS_ARCHIVE}"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a previous descriptor that is not its product row's kernel" \
    "not its product row's kernel ${K}" collect x64-dev x64/20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
printf '%s\n' "x64-dev	x64	1	x64/20260914-2042	${KERNEL}	${ROOTFS}" >"${SCRATCH}/plan.tsv"
cp "${SCRATCH}/fixtures/other-key.micaupd" "${PREVIOUS_ARCHIVE}"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a previous descriptor signed by another key" \
    "does not authenticate with this release's updates key" collect x64-dev x64/20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
cp "${SCRATCH}/fixtures/same.micaupd" "${PREVIOUS_ARCHIVE}"
if collect "x64-dev	x64	1	-	-	-" "${SCRATCH}/first" >/dev/null 2>&1 && [ "$(assets_of "${SCRATCH}/first")" = "image/disk update/full " ] &&
    [ "$(ls "${SCRATCH}/first/assets")" = "mica-x64-dev-20260916-0000.img.gz
mica-x64-dev-20260916-0000.micaupd" ] &&
    [ "$(awk -F'\t' '$1 == "asset" && $3 == "image" { print $5, $6 }' "${SCRATCH}/first/rows/x64-dev.tsv")" = "mica-x64-dev-20260916-0000.img.gz $(sha "${SCRATCH}/first/assets/mica-x64-dev-20260916-0000.img.gz")" ] &&
    [ "$(cat "${SCRATCH}/first/rows/x64-dev.uncompressed")" = "disk	$(sha "${OUT}/kinds/mica-x64-dev-20260916-0000.img")	$(stat -c %s "${OUT}/kinds/mica-x64-dev-20260916-0000.img")" ]; then
    pass "a first release, or one whose kernel and root both changed, ships only full; the image ships as .img.gz recording its raw sha256 and size"
else
    fail "collect without a previous release: $(assets_of "${SCRATCH}/first" 2>&1)"
fi
printf 'release 20260916-0000\ngeneration 2\n' >"${OUT}/receipt.txt"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a build of another generation than the plan" \
    "is not a build of release 20260916-0000 at generation 1" collect x64-dev x64/20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
printf 'release 20260916-0000\ngeneration 1\n' >"${OUT}/receipt.txt"
printf 'changed\n' >>"${OUT}/kinds/mica-x64-dev-20260916-0000.img"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a file that is not its table's bytes" \
    "does not hash to its kinds.tsv row" collect x64-dev x64/20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"

# --- 3. The publication: bundles in a registry, read back, and the lock.
IMAGE="$(bash tools/from.sh --ref upstream:registry:3.1.1@amd64)"
docker network inspect traefik >/dev/null 2>&1 || docker network create --label ai-agent=true traefik >/dev/null
# The registry by its name where this runs on the traefik network (a sibling container), else by the
# loopback port the host publishes (a CI runner).
docker run -d --rm --label ai-agent=true --name "${REGISTRY_NAME}" --network traefik -p 127.0.0.1::5000 "${IMAGE}" >/dev/null
REGISTRY_ADDRESS=""
for _ in $(seq 1 30); do
    for candidate in "${REGISTRY_NAME}:5000" "127.0.0.1:$(docker port "${REGISTRY_NAME}" 5000/tcp | head -1 | cut -d: -f2)"; do
        curl -fsS "http://${candidate}/v2/" >/dev/null 2>&1 && { REGISTRY_ADDRESS="${candidate}"; break 2; }
    done
    sleep 1
done
[ -n "${REGISTRY_ADDRESS}" ] || { echo "error: the registry ${REGISTRY_NAME} did not answer" >&2; exit 1; }
export MICA_REGISTRY="${REGISTRY_ADDRESS}/micaoss" MICA_REGISTRY_PLAIN_HTTP=1
DIR="${SCRATCH}/root-only"
if out="$(release publish x64/20260916-0000 "${DIR}" 2>&1)" && python3 tools/locks.py lock "${DIR}/mica-build.lock" >/dev/null &&
    [ "$(cat "${DIR}/SHA256SUMS")" = "$(sha "${DIR}/mica-build.lock")  mica-build.lock" ]; then
    pass "publish writes a valid mica-build.lock and SHA256SUMS listing only it"
else
    fail "publish: ${out}"
fi
image_reference="$(awk -F'\t' '$1 == "bundle" && $3 == "image" { print $4 }' "${DIR}/mica-build.lock")"
image_manifest="$(curl -fsS -H 'Accept: application/vnd.oci.image.manifest.v1+json' "http://${REGISTRY_ADDRESS}/v2/micaoss/mica-build/manifests/${image_reference##*@}")"
if [ "$(printf '%s' "${image_manifest}" | jq -c '[.layers[] | [.annotations["org.opencontainers.image.title"], .annotations["mica.image-kind"], .annotations["mica.compression"], .annotations["mica.uncompressed-sha256"], .annotations["mica.uncompressed-size"]]]')" = \
    "[[\"mica-x64-dev-20260916-0000.img.gz\",\"disk\",\"gzip\",\"$(cut -f2 "${DIR}/rows/x64-dev.uncompressed")\",\"$(cut -f3 "${DIR}/rows/x64-dev.uncompressed")\"]]" ] &&
    [ "$(cut -f2 "${DIR}/rows/x64-dev.uncompressed")" = "$(sha "${SCRATCH}/raw-disk.img")" ]; then
    pass "the image bundle's layer is the .img.gz, annotated with gzip and the raw image's sha256 and size"
else
    fail "image bundle ${image_reference}: ${image_manifest}"
fi
reference="$(awk -F'\t' '$1 == "bundle" && $3 == "update" { print $4 }' "${DIR}/mica-build.lock")"
manifest="$(curl -fsS -H 'Accept: application/vnd.oci.image.manifest.v1+json' "http://${REGISTRY_ADDRESS}/v2/micaoss/mica-build/manifests/${reference##*@}")"
if [[ "${reference}" == "ghcr.io/micaoss/mica-build:update.x64-dev.20260916-0000@sha256:"* ]] &&
    [ "$(printf '%s' "${manifest}" | jq -c '[.artifactType, [.layers[] | [.annotations["org.opencontainers.image.title"], .annotations["mica.update-kind"], .annotations["mica.deployment-id"], .annotations["mica.generation"]]]]')" = \
      "[\"application/vnd.mica.update\",[[\"mica-x64-dev-20260916-0000.micaupd\",\"full\",\"${DEPLOYMENT}\",\"1\"],[\"mica-x64-dev-20260916-0000.root.micaupd\",\"root\",\"${DEPLOYMENT}\",\"1\"]]]" ]; then
    pass "the update bundle carries one layer per shipped kind, annotated with kind, deployment and generation"
else
    fail "update bundle ${reference}: ${manifest}"
fi
if [ "$(printf '%s' "${manifest}" | jq -r '.layers[0].digest')" = "sha256:$(awk -F'\t' '$1 == "asset" && $4 == "full" { print $6 }' "${DIR}/mica-build.lock")" ] &&
    [ "$(awk -F'\t' '$1 == "input" { print $2 }' "${DIR}/mica-build.lock" | tr '\n' ' ')" = "$(for p in locks/pins/*.pin; do n="$(basename "${p}" .pin)"; case "${n}" in mica-boards.*) [ "${n}" = mica-boards.x64 ] || continue ;; esac; printf '%s ' "${n}"; done)" ]; then
    pass "each asset row is its layer's digest, and the inputs are the pins with the scope's board alone"
else
    fail "asset digests or inputs: $(grep -E $'^(input|asset)\t' "${DIR}/mica-build.lock")"
fi
cp "${DIR}/mica-build.lock" "${SCRATCH}/first.lock"
if release publish x64/20260916-0000 "${DIR}" >/dev/null 2>&1 && cmp -s "${DIR}/mica-build.lock" "${SCRATCH}/first.lock"; then
    pass "publishing the same files again finds the bundles in place and writes the same lock"
else
    fail "a second publish of the same files"
fi
printf 'other\n' >>"${DIR}/assets/mica-x64-dev-20260916-0000.root.micaupd"
expect_refusal "a bundle tag that holds another digest" "a published tag is never re-pointed" publish x64/20260916-0000 "${DIR}"

# --- 4. The Mica version index over the published release above: the newest release of every published product,
# its lock and mica-index.json, the refusals, and the independent rebuild the verifier makes.
truncate -s -6 "${DIR}/assets/mica-x64-dev-20260916-0000.root.micaupd"
IDX="${SCRATCH}/index"
mkdir -p "${IDX}/history/x64_20260916-0000" "${IDX}/assets" "${IDX}/downloads/x64/20260916-0000"
cp "${DIR}/mica-build.lock" "${DIR}/SHA256SUMS" "${IDX}/history/x64_20260916-0000/"
cp -r "${DIR}/assets" "${IDX}/assets/x64_20260916-0000"
cp "${DIR}/mica-build.lock" "${DIR}/SHA256SUMS" "${IDX}/downloads/x64/20260916-0000/"
for b in $(python3 tools/locks.py rows board | awk -F'\t' '$3 == "board" { print $2 }'); do
    mkdir -p "${IDX}/boards/${b}"
    printf 'BOARD_RELEASE_TARGET=%s\n' "$([ "${b}" = x64 ] && echo 1 || echo 0)" >"${IDX}/boards/${b}/board.env"
done
index_env() { # [env...] command...
    env MICA_RELEASE_HISTORY="${IDX}/history" MICA_RELEASE_ASSETS="${IDX}/assets" MICA_INDEX_BOARD_ENV_DIR="${IDX}/boards" \
        MICA_RELEASE_DOWNLOADS="file://${IDX}/downloads" MICA_INDEX_STAMP=20260917-0000 "$@"
}
expect_index_refusal() { # <label> <fragment> [env...]
    local label="$1" fragment="$2" out; shift 2
    if out="$(index_env "$@" bash tools/release.sh index --dry-run 2>&1)"; then fail "${label}: the index was built"
    elif printf '%s' "${out}" | grep -F -- "${fragment}" >/dev/null; then pass "${label}: refused naming '${fragment}'"
    else fail "${label}: refused, but not naming '${fragment}': $(printf '%s' "${out}" | tail -3)"; fi
}
if out="$(index_env MICA_INDEX_OUT="${IDX}/one" bash tools/release.sh index --dry-run 2>&1)" && python3 tools/locks.py lock "${IDX}/one/mica-build.lock" >/dev/null; then
    pass "an index of the newest release of every published product is built, and its lock is valid"
else
    fail "index --dry-run: $(printf '%s' "${out}" | tail -5)"
fi
L="${IDX}/one/mica-build.lock"
if [ "$(awk -F'\t' '$1 == "release" { print $3 }' "${L}")" = mica/20260917-0000 ] &&
    [ "$(grep $'^input\t' "${L}")" = "input	mica-build.x64	20260916-0000	$(sha "${DIR}/SHA256SUMS")" ] &&
    [ "$(grep $'^origin\t' "${L}")" = "origin	mica-build.x64	$(awk -F'\t' '$1 == "release" { print $4 }' "${DIR}/mica-build.lock")" ] &&
    [ "$(grep $'^built\t' "${L}" | cut -f3-)" = "$(grep $'^input\t' "${DIR}/mica-build.lock" | cut -f2-)" ] &&
    [ "$(grep $'^index\t' "${L}")" = "index	x64-dev	mica-build.x64" ] &&
    [ "$(grep -E $'^(product|bundle|asset)\t' "${L}")" = "$(grep -E $'^(product|bundle|asset)\t' "${DIR}/mica-build.lock")" ]; then
    pass "the lock holds the release's trust hash, origin and built rows, and its product, bundle and asset rows byte-for-byte"
else
    fail "index lock rows: $(cat "${L}")"
fi
if [ "$(jq -c '[.schema, .version, (.releases | map(.release)), (.products[0] | [.product, .generation, (.images | map([.kind, .compression, .uncompressedSize])), (.updates | map([.kind, (.requires | keys)]))]), (.catalogue.products | map(select(.product == "x64-prod" or .product == "x64-minimal")) | map([.product, .publish, .indexed])), (.catalogue.boards | map(select(.board == "x64")) | map(.releaseTarget))]' "${IDX}/one/mica-index.json")" = \
    "[\"mica/index/v1\",\"20260917-0000\",[\"x64/20260916-0000\"],[\"x64-dev\",1,[[\"disk\",\"gzip\",$(cut -f3 "${DIR}/rows/x64-dev.uncompressed")]],[[\"full\",[\"generationBelow\"]],[\"root\",[\"generationBelow\",\"kernel\"]]]],[[\"x64-minimal\",0,false],[\"x64-prod\",1,false]],[true]]" ] &&
    [ "$(jq -c '[keys_unsorted, (.lock | keys_unsorted), (.releases[0] | keys_unsorted), (.releases[0].inputs | map(keys_unsorted) | unique), (.products[0] | keys_unsorted), (.products[0].bundles | keys_unsorted), (.products[0].images[0] | keys_unsorted), (.products[0].updates[1] | keys_unsorted), (.products[0].updates[1].requires | keys_unsorted), (.catalogue | keys_unsorted), (.catalogue.boards[0] | keys_unsorted), (.catalogue.boards[0].pinnedBoardsRelease | keys_unsorted), (.catalogue.products[0] | keys_unsorted)]' "${IDX}/one/mica-index.json")" = \
    '[["schema","version","commit","lock","releases","products","catalogue"],["file","sha256"],["release","trust","commit","inputs"],[["repository","release","trust"],["repository","scope","release","trust"]],["product","board","profile","generation","deployment","kernel","rootfs","release","bundles","images","updates"],["image","update"],["kind","file","url","sha256","size","compression","uncompressedSha256","uncompressedSize"],["kind","file","url","sha256","size","requires"],["generationBelow","kernel"],["boards","products"],["board","arch","releaseTarget","pinnedBoardsRelease"],["release","trust"],["product","board","profile","features","publish","indexed"]]' ] &&
    [ "$(cat "${IDX}/one/SHA256SUMS")" = "$(cd "${IDX}/one" && sha256sum mica-build.lock mica-index.json)" ]; then
    pass "mica-index.json renders the releases, the products with image and update requirements, and the catalogue; SHA256SUMS lists both"
else
    fail "mica-index.json: $(head -c 600 "${IDX}/one/mica-index.json")"
fi
if index_env MICA_INDEX_OUT="${IDX}/two" bash tools/release.sh index --dry-run >/dev/null 2>&1 && cmp -s "${IDX}/one/mica-build.lock" "${IDX}/two/mica-build.lock" && cmp -s "${IDX}/one/mica-index.json" "${IDX}/two/mica-index.json"; then
    pass "a second index run gives the same lock and mica-index.json"
else
    fail "a second index run differs"
fi
expect_refusal "a mica/* release published by hand" "cut by the index job of a scoped release, never by hand" plan mica/20260917-0000
expect_index_refusal "a stamp not later than a referenced release" "the stamp 20260916-0000 is not later than 20260916-0000" MICA_INDEX_STAMP=20260916-0000
mkdir -p "${IDX}/history/mica_20260916-1200"
sed -e 's|mica/20260917-0000|mica/20260916-1200|' -e $'s|^\\(product\tx64-dev\tx64\tdev\t\\)1\t|\\19\t|' "${L}" >"${IDX}/history/mica_20260916-1200/mica-build.lock"
cp "${IDX}/one/mica-index.json" "${IDX}/history/mica_20260916-1200/"
(cd "${IDX}/history/mica_20260916-1200" && sha256sum mica-build.lock mica-index.json >SHA256SUMS)
expect_index_refusal "a generation lower than in the previous index" "x64-dev: generation 1 of x64/20260916-0000 is lower than 9 in the previous index mica/20260916-1200"
rm -rf "${IDX}/history/mica_20260916-1200"
mkdir -p "${IDX}/history/x64_20260916-0100"
sed -e 's/x64-dev/x64-prod/g' -e 's/20260916-0000/20260916-0100/g' "${DIR}/mica-build.lock" >"${IDX}/history/x64_20260916-0100/mica-build.lock"
(cd "${IDX}/history/x64_20260916-0100" && sha256sum mica-build.lock >SHA256SUMS)
expect_index_refusal "products of one scope from two releases" "products of the scope x64 come from two releases"
rm -rf "${IDX}/history/x64_20260916-0100"
mkdir -p "${IDX}/downloads/mica/20260917-0000"
cp "${IDX}/one/mica-build.lock" "${IDX}/one/mica-index.json" "${IDX}/one/SHA256SUMS" "${IDX}/downloads/mica/20260917-0000/"
if out="$(index_env bash tools/release.sh verify-index mica/20260917-0000 2>&1)" && printf '%s' "${out}" | grep -F "rebuilt byte-identically" >/dev/null; then
    pass "verify-index rebuilds the published index from the releases it references, byte-identically"
else
    fail "verify-index: $(printf '%s' "${out}" | tail -4)"
fi
sed -i $'s|^\\(built\tmica-build.x64\tmica-core\t[^\t]*\t\\).*|\\1'"$(printf '9%.0s' $(seq 64))"'|' "${IDX}/downloads/mica/20260917-0000/mica-build.lock"
(cd "${IDX}/downloads/mica/20260917-0000" && sha256sum mica-build.lock mica-index.json >SHA256SUMS)
if out="$(index_env bash tools/release.sh verify-index mica/20260917-0000 2>&1)"; then
    fail "verify-index accepted an index whose built row differs from its referenced lock"
elif printf '%s' "${out}" | grep -F "mica-build.lock of mica/20260917-0000 differs from the index rebuilt from its references" >/dev/null; then
    pass "verify-index refuses an index whose copied row differs from the referenced lock"
else
    fail "verify-index refused, but not naming the difference: $(printf '%s' "${out}" | tail -3)"
fi

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
