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
PREVIOUS="${HISTORY}/uefi-x64.20260914-2042"
mkdir -p "${PREVIOUS}"
# The spec vector names the board x64; this tree's board is uefi-x64, so the fixture is renamed on the way in.
sed -e 's/\bx64\b/uefi-x64/g' tests/release-lock/vectors/lock/valid/mica-build.x64.lock >"${PREVIOUS}/mica-build.lock"
(cd "${PREVIOUS}" && sha256sum mica-build.lock >SHA256SUMS)
K="$(printf 'b%.0s' $(seq 64))"; R="$(printf 'c%.0s' $(seq 64))"
export MICA_RELEASE_HISTORY="${HISTORY}"

if [ "$(release plan uefi-x64.20260916-0000)" = "uefi-x64-dev	uefi-x64	4	uefi-x64.20260914-2042	${K}	${R}
uefi-x64-prod	uefi-x64	2	-	-	-" ]; then
    pass "a board scope plans every product of its board, one generation above their previous release"
else
    fail "plan uefi-x64: $(release plan uefi-x64.20260916-0000 2>&1)"
fi
if [ "$(release plan uefi-arm64-dev.20260916-0000)" = "uefi-arm64-dev	uefi-arm64	2	-	-	-" ]; then
    pass "a product scope plans that product, at generation 2 for its first release"
else
    fail "plan uefi-arm64-dev: $(release plan uefi-arm64-dev.20260916-0000 2>&1)"
fi
expect_refusal "an unscoped tag" "must be <scope>.<YYYYMMDD-HHMM>" plan 20260916-0000
expect_refusal "a scope that is no product or board" "neither a product nor the board of a product" plan nosuch.20260916-0000
# The retired <scope>/<stamp> form (mica:docs/decisions/2026-09-16-scoped-tags-use-a-dot.md) is no release tag here.
expect_refusal "a slash between the scope and the stamp" "must be <scope>.<YYYYMMDD-HHMM>" plan uefi-x64/20260916-0000
expect_refusal "a slash index tag" "verify-index takes mica.<YYYYMMDD-HHMM>" verify-index mica/20260915-2242
mkdir -p "${HISTORY}/uefi-x64.20260915-0100"
sed 's|uefi-x64\.20260914-2042|uefi-x64/20260914-2042|' "${PREVIOUS}/mica-build.lock" >"${HISTORY}/uefi-x64.20260915-0100/mica-build.lock"
(cd "${HISTORY}/uefi-x64.20260915-0100" && sha256sum mica-build.lock >SHA256SUMS)
expect_refusal "an earlier release whose lock carries a slash release row" "its mica-build.lock breaks a rule" plan uefi-x64-dev.20260916-0000
rm -rf "${HISTORY}/uefi-x64.20260915-0100"
# A generation floor for a history this tree no longer reads; it never lowers one.
if [ "$(MICA_RELEASE_GENERATIONS="uefi-x64-dev=9 uefi-x64-prod=4" release plan uefi-x64.20260916-0000 | cut -f1,3)" = "uefi-x64-dev	9
uefi-x64-prod	4" ]; then
    pass "MICA_RELEASE_GENERATIONS raises a planned generation"
else
    fail "the generation floor: $(MICA_RELEASE_GENERATIONS="uefi-x64-dev=9 uefi-x64-prod=4" release plan uefi-x64.20260916-0000 2>&1 | tail -2)"
fi
MICA_RELEASE_GENERATIONS="uefi-x64-dev=3" expect_refusal "a generation floor below the planned generation" \
    "gives uefi-x64-dev generation 3, below the planned 4" plan uefi-x64.20260916-0000
MICA_RELEASE_GENERATIONS="uefi-x64-dev=one" expect_refusal "a generation floor that is no decimal" \
    "each item is <product>=<generation>, a decimal of at least 2" plan uefi-x64.20260916-0000
mkdir -p "${HISTORY}/uefi-x64.20260916-0000" "${HISTORY}/uefi-x64.20260915-0000"
if [ "$(release plan uefi-x64-dev.20260916-0000 | cut -f3,4)" = "4	uefi-x64.20260914-2042" ]; then
    pass "the release being built and an earlier release with no asset (a failed run) are not previous releases"
else
    fail "plan past an empty release: $(release plan uefi-x64-dev.20260916-0000 2>&1)"
fi
printf 'partial\n' >"${HISTORY}/uefi-x64.20260915-0000/mica-uefi-x64-dev-20260915-0000.img"
expect_refusal "an earlier release with assets and no lock" "release uefi-x64.20260915-0000: SHA256SUMS does not list exactly its mica-build.lock" plan uefi-x64-dev.20260916-0000
rm -rf "${HISTORY}/uefi-x64.20260916-0000" "${HISTORY}/uefi-x64.20260915-0000"
expect_refusal "a release older than the previous one" "which is not earlier than 20260913-0000" plan uefi-x64-dev.20260913-0000
printf '0%.0s' $(seq 64) >"${PREVIOUS}/SHA256SUMS"
expect_refusal "a previous release whose SHA256SUMS does not list its lock" "SHA256SUMS does not list exactly its mica-build.lock" plan uefi-x64.20260916-0000
(cd "${PREVIOUS}" && sha256sum mica-build.lock >SHA256SUMS)

# --- 2. The collection: which update packages ship, against the previous identities, and the guard that
# refuses a kernel packed to other bytes from the same inputs. The contract's deployment, and variants of
# it for the previous release's archive, signed with a throwaway updates key.
PRODUCTS="${SCRATCH}/products"
OUT="${PRODUCTS}/uefi-x64-dev"
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
# The contract fixture is mica-core's copy and names its own product and board; this tree's are the renamed
# ones, and collect refuses a deployment naming another product, so the fixture is renamed here, its kernel id
# recomputed over the renamed content, and everything re-signed below.
def ident(component):
    content = {k: v for k, v in component.items() if k != 'id'}
    component['id'] = hashlib.sha256(canonical(content).encode()).hexdigest()
payload['product'], payload['board'], payload['kernel']['board'] = 'uefi-x64-dev', 'uefi-x64', 'uefi-x64'
ident(payload['kernel'])
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
print(payload['kernel']['id'], payload['rootfs']['id'], rebuilt['kernel']['id'], repacked['kernel']['id'],
      hashlib.sha256(canonical(payload).encode()).hexdigest())
PY
)"
# mica-build-side: host
read -r KERNEL ROOTFS K_REBUILT K_REPACKED DEPLOYMENT <<<"${FIXTURE_IDS}"
cp "${SCRATCH}/fixtures/public.key" "${SIGNING}/updates/public.key"
cp "${SCRATCH}/fixtures/current.json" "${OUT}/deployments/1.json"
PREVIOUS_ARCHIVE="${PREVIOUS}/mica-uefi-x64-dev-20260914-2042.micaupd"
printf 'release 20260916-0000\ngeneration 1\n' >"${OUT}/receipt.txt"
product_file() { # <table> <kind> <file>
    printf '%s bytes\n' "$3" >"${OUT}/$3"
    printf '%s\t%s\t%s\n' "$2" "$3" "$(sha "${OUT}/$3")" >>"${OUT}/$1"
}
: >"${OUT}/kinds.tsv"; : >"${OUT}/updates.tsv"
product_file kinds.tsv disk kinds/mica-uefi-x64-dev-20260916-0000.img
cp "${OUT}/kinds/mica-uefi-x64-dev-20260916-0000.img" "${SCRATCH}/raw-disk.img"
product_file updates.tsv full updates/mica-uefi-x64-dev-20260916-0000.micaupd
product_file updates.tsv kernel updates/mica-uefi-x64-dev-20260916-0000.kernel.micaupd
product_file updates.tsv root updates/mica-uefi-x64-dev-20260916-0000.root.micaupd
collect() { # <plan line> <dir>
    printf '%s\n' "$1" >"${SCRATCH}/plan.tsv"
    MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" release collect uefi-x64-dev uefi-x64.20260916-0000 "${SCRATCH}/plan.tsv" "$2"
}
assets_of() { awk -F'\t' '$1 == "asset" { print $3 "/" $4 }' "$1/rows/uefi-x64-dev.tsv" | tr '\n' ' '; }

cp "${SCRATCH}/fixtures/same.micaupd" "${PREVIOUS_ARCHIVE}"
if collect "uefi-x64-dev	uefi-x64	1	uefi-x64.20260914-2042	${KERNEL}	${R}" "${SCRATCH}/root-only" >/dev/null 2>&1 &&
    [ "$(assets_of "${SCRATCH}/root-only")" = "image/disk update/full update/root " ] &&
    [ "$(grep $'^product\t' "${SCRATCH}/root-only/rows/uefi-x64-dev.tsv")" = "product	uefi-x64-dev	uefi-x64	dev	1	${DEPLOYMENT}	${KERNEL}	${ROOTFS}" ]; then
    pass "an unchanged kernel id ships the root package, and the product row is the signed deployment's"
else
    fail "collect with the previous kernel: $(collect "uefi-x64-dev	uefi-x64	1	uefi-x64.20260914-2042	${KERNEL}	${R}" "${SCRATCH}/root-only" 2>&1 | tail -3)"
fi
cp "${SCRATCH}/fixtures/rebuilt.micaupd" "${PREVIOUS_ARCHIVE}"
if collect "uefi-x64-dev	uefi-x64	1	uefi-x64.20260914-2042	${K_REBUILT}	${ROOTFS}" "${SCRATCH}/kernel-only" >/dev/null 2>&1 &&
    [ "$(assets_of "${SCRATCH}/kernel-only")" = "image/disk update/full update/kernel " ]; then
    pass "an unchanged rootfs id ships the kernel package, and a kernel of other inputs passes the guard"
else
    fail "collect with the previous rootfs: $(collect "uefi-x64-dev	uefi-x64	1	uefi-x64.20260914-2042	${K_REBUILT}	${ROOTFS}" "${SCRATCH}/kernel-only" 2>&1 | tail -2)"
fi
printf '%s\n' "uefi-x64-dev	uefi-x64	1	uefi-x64.20260914-2042	${K_REPACKED}	${ROOTFS}" >"${SCRATCH}/plan.tsv"
cp "${SCRATCH}/fixtures/repacked.micaupd" "${PREVIOUS_ARCHIVE}"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a kernel of the previous release's buildId packed to another id" \
    "equals release uefi-x64.20260914-2042's, and the kernel id ${KERNEL} differs" collect uefi-x64-dev uefi-x64.20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
printf '%s\n' "uefi-x64-dev	uefi-x64	1	uefi-x64.20260914-2042	${K}	${ROOTFS}" >"${SCRATCH}/plan.tsv"
cp "${SCRATCH}/fixtures/same.micaupd" "${PREVIOUS_ARCHIVE}"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a previous descriptor that is not its product row's kernel" \
    "not its product row's kernel ${K}" collect uefi-x64-dev uefi-x64.20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
printf '%s\n' "uefi-x64-dev	uefi-x64	1	uefi-x64.20260914-2042	${KERNEL}	${ROOTFS}" >"${SCRATCH}/plan.tsv"
cp "${SCRATCH}/fixtures/other-key.micaupd" "${PREVIOUS_ARCHIVE}"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a previous descriptor signed by another key" \
    "does not authenticate with this release's updates key" collect uefi-x64-dev uefi-x64.20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
cp "${SCRATCH}/fixtures/same.micaupd" "${PREVIOUS_ARCHIVE}"
if collect "uefi-x64-dev	uefi-x64	1	-	-	-" "${SCRATCH}/first" >/dev/null 2>&1 && [ "$(assets_of "${SCRATCH}/first")" = "image/disk update/full " ] &&
    [ "$(ls "${SCRATCH}/first/assets")" = "mica-uefi-x64-dev-20260916-0000.img.gz
mica-uefi-x64-dev-20260916-0000.micaupd" ] &&
    [ "$(awk -F'\t' '$1 == "asset" && $3 == "image" { print $5, $6 }' "${SCRATCH}/first/rows/uefi-x64-dev.tsv")" = "mica-uefi-x64-dev-20260916-0000.img.gz $(sha "${SCRATCH}/first/assets/mica-uefi-x64-dev-20260916-0000.img.gz")" ] &&
    [ "$(cat "${SCRATCH}/first/rows/uefi-x64-dev.uncompressed")" = "disk	$(sha "${OUT}/kinds/mica-uefi-x64-dev-20260916-0000.img")	$(stat -c %s "${OUT}/kinds/mica-uefi-x64-dev-20260916-0000.img")" ]; then
    pass "a first release, or one whose kernel and root both changed, ships only full; the image ships as .img.gz recording its raw sha256 and size"
else
    fail "collect without a previous release: $(assets_of "${SCRATCH}/first" 2>&1)"
fi
printf 'release 20260916-0000\ngeneration 2\n' >"${OUT}/receipt.txt"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a build of another generation than the plan" \
    "is not a build of release 20260916-0000 at generation 1" collect uefi-x64-dev uefi-x64.20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"
printf 'release 20260916-0000\ngeneration 1\n' >"${OUT}/receipt.txt"
printf 'changed\n' >>"${OUT}/kinds/mica-uefi-x64-dev-20260916-0000.img"
MICA_RELEASE_PRODUCTS="${PRODUCTS}" MICA_SIGNING_OUTPUT="${SIGNING}" expect_refusal "a file that is not its table's bytes" \
    "does not hash to its kinds.tsv row" collect uefi-x64-dev uefi-x64.20260916-0000 "${SCRATCH}/plan.tsv" "${SCRATCH}/refused"

# --- 3. The publication: bundles in a registry, read back, and the lock.
IMAGE="$(bash tools/from.sh --ref upstream:registry:3.1.1@amd64)"
docker network inspect traefik >/dev/null 2>&1 || docker network create --label ai-agent=true traefik >/dev/null
# The registry by its name where this runs on the traefik network (a sibling container), else by the
# loopback port the host publishes (a CI runner).
docker run -d --rm --label ai-agent=true --name "${REGISTRY_NAME}" --network traefik -p 127.0.0.1::5000 "${IMAGE}" >/dev/null
REGISTRY_ADDRESS=""
for _ in $(seq 1 30); do
    for candidate in "${REGISTRY_NAME}:5000" "127.0.0.1:$(docker port "${REGISTRY_NAME}" 5000/tcp | sed -n '1p' | cut -d: -f2)"; do
        curl -fsS "http://${candidate}/v2/" >/dev/null 2>&1 && { REGISTRY_ADDRESS="${candidate}"; break 2; }
    done
    sleep 1
done
[ -n "${REGISTRY_ADDRESS}" ] || { echo "error: the registry ${REGISTRY_NAME} did not answer" >&2; exit 1; }
export MICA_REGISTRY="${REGISTRY_ADDRESS}/micaoss" MICA_REGISTRY_PLAIN_HTTP=1
DIR="${SCRATCH}/root-only"
if out="$(release publish uefi-x64.20260916-0000 "${DIR}" 2>&1)" && python3 tools/locks.py lock "${DIR}/mica-build.lock" >/dev/null &&
    [ "$(cat "${DIR}/SHA256SUMS")" = "$(sha "${DIR}/mica-build.lock")  mica-build.lock" ]; then
    pass "publish writes a valid mica-build.lock and SHA256SUMS listing only it"
else
    fail "publish: ${out}"
fi
image_reference="$(awk -F'\t' '$1 == "bundle" && $3 == "image" { print $4 }' "${DIR}/mica-build.lock")"
image_manifest="$(curl -fsS -H 'Accept: application/vnd.oci.image.manifest.v1+json' "http://${REGISTRY_ADDRESS}/v2/micaoss/mica-build/manifests/${image_reference##*@}")"
if [ "$(printf '%s' "${image_manifest}" | jq -c '[.layers[] | [.annotations["org.opencontainers.image.title"], .annotations["mica.image-kind"], .annotations["mica.compression"], .annotations["mica.uncompressed-sha256"], .annotations["mica.uncompressed-size"]]]')" = \
    "[[\"mica-uefi-x64-dev-20260916-0000.img.gz\",\"disk\",\"gzip\",\"$(cut -f2 "${DIR}/rows/uefi-x64-dev.uncompressed")\",\"$(cut -f3 "${DIR}/rows/uefi-x64-dev.uncompressed")\"]]" ] &&
    [ "$(cut -f2 "${DIR}/rows/uefi-x64-dev.uncompressed")" = "$(sha "${SCRATCH}/raw-disk.img")" ]; then
    pass "the image bundle's layer is the .img.gz, annotated with gzip and the raw image's sha256 and size"
else
    fail "image bundle ${image_reference}: ${image_manifest}"
fi
reference="$(awk -F'\t' '$1 == "bundle" && $3 == "update" { print $4 }' "${DIR}/mica-build.lock")"
manifest="$(curl -fsS -H 'Accept: application/vnd.oci.image.manifest.v1+json' "http://${REGISTRY_ADDRESS}/v2/micaoss/mica-build/manifests/${reference##*@}")"
if [[ "${reference}" == "ghcr.io/micaoss/mica-build:update.uefi-x64-dev.20260916-0000@sha256:"* ]] &&
    [ "$(printf '%s' "${manifest}" | jq -c '[.artifactType, [.layers[] | [.annotations["org.opencontainers.image.title"], .annotations["mica.update-kind"], .annotations["mica.deployment-id"], .annotations["mica.generation"]]]]')" = \
      "[\"application/vnd.mica.update\",[[\"mica-uefi-x64-dev-20260916-0000.micaupd\",\"full\",\"${DEPLOYMENT}\",\"1\"],[\"mica-uefi-x64-dev-20260916-0000.root.micaupd\",\"root\",\"${DEPLOYMENT}\",\"1\"]]]" ]; then
    pass "the update bundle carries one layer per shipped kind, annotated with kind, deployment and generation"
else
    fail "update bundle ${reference}: ${manifest}"
fi
if [ "$(printf '%s' "${manifest}" | jq -r '.layers[0].digest')" = "sha256:$(awk -F'\t' '$1 == "asset" && $4 == "full" { print $6 }' "${DIR}/mica-build.lock")" ] &&
    [ "$(awk -F'\t' '$1 == "input" { print $2 }' "${DIR}/mica-build.lock" | tr '\n' ' ')" = "$(for p in locks/pins/*.pin; do n="$(basename "${p}" .pin)"; case "${n}" in mica-boards.*) [ "${n}" = mica-boards.uefi-x64 ] || continue ;; esac; printf '%s ' "${n}"; done)" ]; then
    pass "each asset row is its layer's digest, and the inputs are the pins with the scope's board alone"
else
    fail "asset digests or inputs: $(grep -E $'^(input|asset)\t' "${DIR}/mica-build.lock")"
fi
cp "${DIR}/mica-build.lock" "${SCRATCH}/first.lock"
if release publish uefi-x64.20260916-0000 "${DIR}" >/dev/null 2>&1 && cmp -s "${DIR}/mica-build.lock" "${SCRATCH}/first.lock"; then
    pass "publishing the same files again finds the bundles in place and writes the same lock"
else
    fail "a second publish of the same files"
fi
printf 'other\n' >>"${DIR}/assets/mica-uefi-x64-dev-20260916-0000.root.micaupd"
expect_refusal "a bundle tag that holds another digest" "a published tag is never re-pointed" publish uefi-x64.20260916-0000 "${DIR}"

# --- 4. The Mica version index over the published release above (A, uefi-x64-dev) and a release of uefi-x64-prod made of its
# files (C): the first index in full, then an incremental one carrying C's entry while a newer release of uefi-x64-dev (B)
# replaces A's; the refusals, a product dropped, and the verifier's incremental and full rebuilds.
truncate -s -6 "${DIR}/assets/mica-uefi-x64-dev-20260916-0000.root.micaupd"
IDX="${SCRATCH}/index"
A=uefi-x64.20260916-0000
mkdir -p "${IDX}/history/uefi-x64.20260916-0000" "${IDX}/downloads/${A}" "${IDX}/assets"
cp "${DIR}/mica-build.lock" "${DIR}/SHA256SUMS" "${IDX}/history/uefi-x64.20260916-0000/"
cp -r "${DIR}/assets" "${IDX}/assets/uefi-x64.20260916-0000"
cp "${DIR}/mica-build.lock" "${DIR}/SHA256SUMS" "${IDX}/downloads/${A}/"
# fabricate <label> <product> <generation>: a release of <product> alone, release A's lock and files renamed (its
# bundle references keep A's manifest digests, which the registry serves).
fabricate() {
    local label="$1" stamp="${1#*.}" dir="${IDX}/history/$1" f
    mkdir -p "${dir}" "${IDX}/assets/$1" "${IDX}/downloads/${label}"
    sed -e "s/uefi-x64-dev/$2/g" -e "s|${A}|${label}|" -e "s/20260916-0000/${stamp}/g" \
        -e $'s/^\\(product\t[^\t]*\t[^\t]*\t[^\t]*\t\\)1\t/\\1'"$3"$'\t/' "${DIR}/mica-build.lock" >"${dir}/mica-build.lock"
    (cd "${dir}" && sha256sum mica-build.lock >SHA256SUMS)
    for f in "${DIR}"/assets/*; do
        cp "${f}" "${IDX}/assets/$1/$(basename "${f}" | sed -e "s/uefi-x64-dev/$2/" -e "s/20260916-0000/${stamp}/")"
    done
    cp "${dir}/mica-build.lock" "${dir}/SHA256SUMS" "${IDX}/downloads/${label}/"
}
C=cx3576-prod.20260916-0100
fabricate "${C}" cx3576-prod 1
for b in $(python3 tools/locks.py rows board | awk -F'\t' '$3 == "board" { print $2 }'); do
    mkdir -p "${IDX}/boards/${b}"
    printf 'BOARD_RELEASE_TARGET=%s\n' "$(case "${b}" in uefi-x64 | cx3576) echo 1 ;; *) echo 0 ;; esac)" >"${IDX}/boards/${b}/board.env"
done
index_env() { # [env...] command...
    env MICA_RELEASE_HISTORY="${IDX}/history" MICA_RELEASE_ASSETS="${IDX}/assets" MICA_INDEX_BOARD_ENV_DIR="${IDX}/boards" \
        MICA_RELEASE_DOWNLOADS="file://${IDX}/downloads" MICA_INDEX_STAMP=20260917-0000 "$@"
}
expect_index_refusal() { # <label> <fragment> [env...] -- [index args...]
    local label="$1" fragment="$2" out envs=()
    shift 2
    while [ "$#" -gt 0 ] && [ "$1" != -- ]; do envs+=("$1"); shift; done
    shift
    if out="$(index_env "${envs[@]}" bash tools/release.sh index --dry-run "$@" 2>&1)"; then fail "${label}: the index was built"
    elif printf '%s' "${out}" | grep -F -- "${fragment}" >/dev/null; then pass "${label}: refused naming '${fragment}'"
    else fail "${label}: refused, but not naming '${fragment}': $(printf '%s' "${out}" | tail -3)"; fi
}
if out="$(index_env MICA_INDEX_OUT="${IDX}/one" bash tools/release.sh index --dry-run "${C}" 2>&1)" && python3 tools/locks.py lock "${IDX}/one/mica-build.lock" >/dev/null &&
    printf '%s' "${out}" | grep -F "mica.20260917-0000: full, 2 product(s) from 2 release(s), 2 entering" >/dev/null; then
    pass "the first index is built in full from the newest release of every published product, and its lock is valid"
else
    fail "index --dry-run: $(printf '%s' "${out}" | tail -5)"
fi
L="${IDX}/one/mica-build.lock"
if [ "$(awk -F'\t' '$1 == "release" { print $3 }' "${L}")" = mica.20260917-0000 ] &&
    [ "$(grep $'^input\t' "${L}")" = "input	mica-build.cx3576-prod	20260916-0100	$(sha "${IDX}/history/cx3576-prod.20260916-0100/SHA256SUMS")
input	mica-build.uefi-x64	20260916-0000	$(sha "${DIR}/SHA256SUMS")" ] &&
    [ "$(grep $'^origin\tmica-build.uefi-x64\t' "${L}")" = "origin	mica-build.uefi-x64	$(awk -F'\t' '$1 == "release" { print $4 }' "${DIR}/mica-build.lock")" ] &&
    [ "$(grep $'^built\tmica-build.uefi-x64\t' "${L}" | cut -f3-)" = "$(grep $'^input\t' "${DIR}/mica-build.lock" | cut -f2-)" ] &&
    [ "$(grep $'^index\t' "${L}")" = "index	cx3576-prod	mica-build.cx3576-prod
index	uefi-x64-dev	mica-build.uefi-x64" ] &&
    [ "$(grep -E $'^(product|bundle|asset)\tuefi-x64-dev\t' "${L}")" = "$(grep -E $'^(product|bundle|asset)\t' "${DIR}/mica-build.lock")" ]; then
    pass "the lock holds each release's trust hash, origin and built rows, and its product, bundle and asset rows byte-for-byte"
else
    fail "index lock rows: $(cat "${L}")"
fi
J="${IDX}/one/mica-index.json"
if [ "$(jq -c '[.schema, .version, (.releases | map(.release)), (.products[] | select(.product == "uefi-x64-dev") | [.product, .generation, (.images | map([.kind, .compression, .uncompressedSize])), (.updates | map([.kind, (.requires | keys)]))]), (.catalogue.products | map(select(.product == "cx3576-prod" or .product == "s905x5m-dev")) | map([.product, .publish, .indexed])), (.catalogue.boards | map(select(.board == "uefi-x64")) | map(.releaseTarget))]' "${J}")" = \
    "[\"mica/index/v1\",\"20260917-0000\",[\"cx3576-prod.20260916-0100\",\"uefi-x64.20260916-0000\"],[\"uefi-x64-dev\",1,[[\"disk\",\"gzip\",$(cut -f3 "${DIR}/rows/uefi-x64-dev.uncompressed")]],[[\"full\",[\"generationBelow\"]],[\"root\",[\"generationBelow\",\"kernel\"]]]],[[\"cx3576-prod\",true,true],[\"s905x5m-dev\",false,false]],[true]]" ] &&
    [ "$(jq -c '[keys_unsorted, (.lock | keys_unsorted), (.inputs | map(keys_unsorted) | unique), (.releases[0] | keys_unsorted), (.products[0] | keys_unsorted), (.products[0].bundles | keys_unsorted), (.products[0].images[0] | keys_unsorted), (.products[1].updates[1] | keys_unsorted), (.products[1].updates[1].requires | keys_unsorted), (.catalogue | keys_unsorted), (.catalogue.boards[0] | keys_unsorted), (.catalogue.boards[0].pinnedBoardsRelease | keys_unsorted), (.catalogue.products[0] | keys_unsorted)]' "${J}")" = \
    '[["schema","version","commit","lock","inputs","releases","products","catalogue"],["file","sha256"],[["id","repository","release","trust"],["id","repository","scope","release","trust"]],["release","trust","commit","inputs"],["product","board","profile","generation","deployment","kernel","rootfs","release","bundles","images","updates"],["image","update"],["kind","file","url","sha256","size","compression","uncompressedSha256","uncompressedSize"],["kind","file","url","sha256","size","requires"],["generationBelow","kernel"],["boards","products"],["board","arch","releaseTarget","pinnedBoardsRelease"],["release","trust"],["product","board","profile","features","publish","indexed"]]' ] &&
    [ "$(cat "${IDX}/one/SHA256SUMS")" = "$(cd "${IDX}/one" && sha256sum mica-build.lock mica-index.json)" ]; then
    pass "mica-index.json renders the releases, the products with image and update requirements, and the catalogue, keys in the shape's order; SHA256SUMS lists both"
else
    fail "mica-index.json: $(head -c 600 "${J}")"
fi
if [ "$(jq -c '[(.inputs | length), (.releases | map(.inputs | length)), ((.inputs | map(.id)) == (.releases | map(.inputs[]) | unique)), ((.inputs | map(.id)) == (.inputs | map(.id) | sort)), (.inputs[] | select(.scope) | [.id, .repository, .scope, .release] | join(" "))]' "${J}")" = \
    "[$(grep -c $'^input\t' "${DIR}/mica-build.lock"),[$(grep -c $'^input\t' "${DIR}/mica-build.lock"),$(grep -c $'^input\t' "${DIR}/mica-build.lock")],true,true,\"mica-boards.uefi-x64/$(awk -F'\t' '$1 == "input" && $2 == "mica-boards.uefi-x64" { print $3 }' "${DIR}/mica-build.lock") mica-boards uefi-x64 $(awk -F'\t' '$1 == "input" && $2 == "mica-boards.uefi-x64" { print $3 }' "${DIR}/mica-build.lock")\"]" ] &&
    [ "$(jq -c '[(.catalogue.products[] | .publish, .indexed), (.catalogue.boards[] | .releaseTarget)] | map(type) | unique' "${J}")" = '["boolean"]' ]; then
    pass "releases name their inputs by id in one shared, sorted input table, and the catalogue's publish, indexed and releaseTarget are booleans"
else
    fail "the input table or the catalogue types: $(jq -c '[(.inputs | length), (.releases | map(.inputs | length)), ((.inputs | map(.id)) == (.releases | map(.inputs[]) | unique)), ((.inputs | map(.id)) == (.inputs | map(.id) | sort)), (.inputs[] | select(.scope) | [.id, .repository, .scope, .release] | join(" "))]' "${J}")"
fi
if index_env MICA_INDEX_OUT="${IDX}/two" bash tools/release.sh index --dry-run "${C}" >/dev/null 2>&1 && cmp -s "${L}" "${IDX}/two/mica-build.lock" && cmp -s "${J}" "${IDX}/two/mica-index.json"; then
    pass "a second index run gives the same lock and mica-index.json"
else
    fail "a second index run differs"
fi
expect_refusal "a mica/* release published by hand" "cut by the index job of a scoped release, never by hand" plan mica.20260917-0000
expect_index_refusal "a stamp not later than a referenced release" "the stamp 20260916-0100 is not later than 20260916-0100" MICA_INDEX_STAMP=20260916-0100 -- "${C}"
fabricate uefi-x64.20260916-0200 uefi-x64-prod 1
expect_index_refusal "products of one scope from two releases" "products of the scope uefi-x64 come from two releases" -- uefi-x64.20260916-0200
rm -rf "${IDX}/history/uefi-x64.20260916-0200"
# The first index is published.
publish_index() { # <dir> <stamp>
    mkdir -p "${IDX}/history/mica.$2" "${IDX}/downloads/mica.$2"
    cp "$1"/mica-build.lock "$1"/mica-index.json "$1"/SHA256SUMS "${IDX}/history/mica.$2/"
    cp "$1"/mica-build.lock "$1"/mica-index.json "$1"/SHA256SUMS "${IDX}/downloads/mica.$2/"
}
publish_index "${IDX}/one" 20260917-0000
if out="$(index_env bash tools/release.sh verify-index mica.20260917-0000 2>&1)" && printf '%s' "${out}" | grep -F "rebuilt byte-identically from its 2 referenced release(s)" >/dev/null; then
    pass "verify-index rebuilds the first index from the releases it references, byte-identically"
else
    fail "verify-index of the first index: $(printf '%s' "${out}" | tail -4)"
fi
# An incremental index: B replaces uefi-x64-dev's entry; C's entry is carried with C's lock and files out of reach.
B=uefi-x64.20260918-0000
fabricate "${B}" uefi-x64-dev 2
mkdir -p "${IDX}/aside/history" "${IDX}/aside/assets"
mv "${IDX}/history/cx3576-prod.20260916-0100" "${IDX}/aside/history/"
mv "${IDX}/assets/cx3576-prod.20260916-0100" "${IDX}/aside/assets/"
rm -rf "${IDX}/history/uefi-x64.20260916-0000"
if out="$(index_env MICA_INDEX_STAMP=20260918-0100 MICA_INDEX_OUT="${IDX}/inc" bash tools/release.sh index --dry-run "${B}" 2>&1)" &&
    printf '%s' "${out}" | grep -F "mica.20260918-0100: incremental, 2 product(s) from 2 release(s), 1 entering, the rest carried from mica.20260917-0000" >/dev/null &&
    [ "$(grep -E $'\tx64-prod(\t|$)|mica-build\\.uefi-x64-prod\t' "${IDX}/inc/mica-build.lock")" = "$(grep -E $'\tx64-prod(\t|$)|mica-build\\.uefi-x64-prod\t' "${L}")" ] &&
    [ "$(grep $'^input\tmica-build.uefi-x64\t' "${IDX}/inc/mica-build.lock" | cut -f3,4)" = "20260918-0000	$(sha "${IDX}/history/uefi-x64.20260918-0000/SHA256SUMS")" ] &&
    [ "$(jq -c '.products[] | select(.product == "cx3576-prod")' "${IDX}/inc/mica-index.json")" = "$(jq -c '.products[] | select(.product == "cx3576-prod")' "${J}")" ] &&
    [ "$(jq -c '[.previous, (.products[] | select(.product == "uefi-x64-dev") | [.release, .generation, .images[0].size])]' "${IDX}/inc/mica-index.json")" = \
      "[{\"release\":\"mica.20260917-0000\",\"trust\":\"$(sha "${IDX}/one/SHA256SUMS")\"},[\"${B}\",2,$(stat -c %s "${DIR}/assets/mica-uefi-x64-dev-20260916-0000.img.gz")]]" ] &&
    [ "$(jq -c 'keys_unsorted' "${IDX}/inc/mica-index.json")" = '["schema","version","commit","lock","previous","inputs","releases","products","catalogue"]' ]; then
    pass "an incremental index carries an unchanged entry from the previous index without reading its release, and the entering release replaces its product's entry"
else
    fail "incremental index: $(printf '%s' "${out}" | tail -4)"
fi
mv "${IDX}/assets/uefi-x64.20260918-0000/mica-uefi-x64-dev-20260918-0000.micaupd" "${IDX}/aside/"
expect_index_refusal "an entering release whose asset does not read back" "the asset mica-uefi-x64-dev-20260918-0000.micaupd of release ${B} does not read back anonymously" MICA_INDEX_STAMP=20260918-0100 -- "${B}"
mv "${IDX}/aside/mica-uefi-x64-dev-20260918-0000.micaupd" "${IDX}/assets/uefi-x64.20260918-0000/"
sed -i 's/"generation":1,/"generation":7,/' "${IDX}/history/mica.20260917-0000/mica-index.json"
expect_index_refusal "a previous index whose files are not its SHA256SUMS" "release mica.20260917-0000: SHA256SUMS does not list exactly its mica-build.lock and mica-index.json" MICA_INDEX_STAMP=20260918-0100 -- "${B}"
(cd "${IDX}/history/mica.20260917-0000" && sha256sum mica-build.lock mica-index.json >SHA256SUMS)
expect_index_refusal "a previous index whose JSON is not its lock" "the previous index mica.20260917-0000: its mica-index.json does not match its mica-build.lock" MICA_INDEX_STAMP=20260918-0100 -- "${B}"
cp "${IDX}/one/mica-index.json" "${IDX}/one/SHA256SUMS" "${IDX}/history/mica.20260917-0000/"
sed -i $'s/^\\(product\tuefi-x64-dev\t[^\t]*\t[^\t]*\t\\)1\t/\\19\t/' "${IDX}/history/mica.20260917-0000/mica-build.lock"
(cd "${IDX}/history/mica.20260917-0000" && sha256sum mica-build.lock mica-index.json >SHA256SUMS)
expect_index_refusal "an entering generation lower than in the previous index" "uefi-x64-dev: generation 2 of ${B} is lower than 9 in the previous index mica.20260917-0000" MICA_INDEX_STAMP=20260918-0100 -- "${B}"
cp "${L}" "${IDX}/one/SHA256SUMS" "${IDX}/history/mica.20260917-0000/"
fabricate uefi-x64.20260918-0200 uefi-x64-dev 2
sed -i $'s/^\\(input\tmica-core\t[^\t]*\t\\).*/\\1'"$(printf '8%.0s' $(seq 64))"'/' "${IDX}/history/uefi-x64.20260918-0200/mica-build.lock"
(cd "${IDX}/history/uefi-x64.20260918-0200" && sha256sum mica-build.lock >SHA256SUMS)
expect_index_refusal "an entering release whose input differs in trust from a carried entry's" "$(printf '8%.0s' $(seq 64)) in another" MICA_INDEX_STAMP=20260918-0300 -- uefi-x64.20260918-0200
rm -rf "${IDX}/history/uefi-x64.20260918-0200"
if out="$(index_env MICA_INDEX_STAMP=20260918-0100 bash tools/release.sh index --dry-run cx3576-prod.20260917-0000 2>&1)"; then
    fail "an index of a release missing from the history was built"
elif ! printf '%s' "${out}" | grep -F "release cx3576-prod.20260917-0000 has no lock to read" >/dev/null; then
    fail "a missing entering release: $(printf '%s' "${out}" | tail -2)"
else
    cp -r "${IDX}/aside/history/cx3576-prod.20260916-0100" "${IDX}/history/"
    if out="$(index_env MICA_INDEX_STAMP=20260918-0100 bash tools/release.sh index --dry-run "${C}" 2>&1)" && printf '%s' "${out}" | grep -F "nothing enters or leaves the previous index mica.20260917-0000" >/dev/null && printf '%s' "${out}" | grep -F "no index is cut" >/dev/null; then
        pass "a missing entering release is refused, and a release no newer than its entries cuts no index"
    else
        fail "a release no newer than its entries: $(printf '%s' "${out}" | tail -2)"
    fi
    rm -rf "${IDX}/history/cx3576-prod.20260916-0100"
fi
# No scoped release at all -- the state right after a tag form changes -- cuts no index and is no refusal.
mkdir -p "${IDX}/empty"
if out="$(env MICA_RELEASE_HISTORY="${IDX}/empty" MICA_INDEX_BOARD_ENV_DIR="${IDX}/boards" MICA_INDEX_STAMP=20260918-0100 \
    bash tools/release.sh index --dry-run 2>&1)" && printf '%s' "${out}" | grep -F "there is nothing to index" >/dev/null &&
    printf '%s' "${out}" | grep -F "no index is cut" >/dev/null; then
    pass "a history without a scoped release cuts no index and is no refusal"
else
    fail "an empty history: $(printf '%s' "${out}" | tail -3)"
fi
# A product whose board stops being a release target is no longer published: its entry is dropped, and the
# catalogue shows it publish false, indexed false (mica:docs/design/mica-index.md 3.1).
printf 'BOARD_RELEASE_TARGET=0\n' >"${IDX}/boards/cx3576/board.env"
if out="$(index_env MICA_INDEX_STAMP=20260918-0100 MICA_INDEX_OUT="${IDX}/dropped" bash tools/release.sh index --dry-run "${B}" 2>&1)" &&
    printf '%s' "${out}" | grep -F "cx3576-prod is no longer published; its entry is dropped" >/dev/null &&
    [ "$(grep -c 'cx3576-prod' "${IDX}/dropped/mica-build.lock")" = 0 ] &&
    [ "$(jq -c '[(.products | map(.product)), (.releases | map(.release)), (.catalogue.products[] | select(.product == "cx3576-prod") | [.publish, .indexed])]' "${IDX}/dropped/mica-index.json")" = "[[\"uefi-x64-dev\"],[\"${B}\"],[false,false]]" ]; then
    pass "the entry of a product whose board is no release target is dropped from the index and shown in the catalogue"
else
    fail "a dropped product: $(printf '%s' "${out}" | tail -4)"
fi
printf 'BOARD_RELEASE_TARGET=1\n' >"${IDX}/boards/cx3576/board.env"
# The verifier: the incremental rebuild reads the previous index and B only; --full reads every reference.
mv "${IDX}/aside/assets/cx3576-prod.20260916-0100" "${IDX}/assets/"
publish_index "${IDX}/inc" 20260918-0100
if out="$(index_env bash tools/release.sh verify-index mica.20260918-0100 2>&1)" && printf '%s' "${out}" | grep -F "rebuilt byte-identically from mica.20260917-0000 and 1 entering release(s)" >/dev/null &&
    out="$(index_env bash tools/release.sh verify-index mica.20260918-0100 --full 2>&1)" && printf '%s' "${out}" | grep -F "verified in full" >/dev/null; then
    pass "verify-index rebuilds an incremental index from its previous index and the entering release, and in full from every reference"
else
    fail "verify-index: $(printf '%s' "${out}" | tail -4)"
fi
sed -i "s/^release\tmica-build\t${C//\//\\/}\t[0-9a-f]*/release\tmica-build\t${C//\//\\/}\t$(printf '7%.0s' $(seq 40))/" "${IDX}/downloads/${C}/mica-build.lock"
(cd "${IDX}/downloads/${C}" && sha256sum mica-build.lock >SHA256SUMS)
if index_env bash tools/release.sh verify-index mica.20260918-0100 >/dev/null 2>&1 &&
    out="$(index_env bash tools/release.sh verify-index mica.20260918-0100 --full 2>&1)"; then
    fail "verify-index --full accepted a carried entry whose release changed"
elif printf '%s' "${out}" | grep -F "mica-build.lock of mica.20260918-0100 differs from the index rebuilt from its references" >/dev/null; then
    pass "a referenced release changed after its entry was indexed passes the incremental rebuild and is refused by --full"
else
    fail "verify-index --full on a changed reference: $(printf '%s' "${out}" | tail -3)"
fi
cp "${IDX}/aside/history/cx3576-prod.20260916-0100/mica-build.lock" "${IDX}/aside/history/cx3576-prod.20260916-0100/SHA256SUMS" "${IDX}/downloads/${C}/"
sed -i $'s|^\\(built\tmica-build.uefi-x64\tmica-core\t[^\t]*\t\\).*|\\1'"$(printf '9%.0s' $(seq 64))"'|' "${IDX}/downloads/mica.20260918-0100/mica-build.lock"
(cd "${IDX}/downloads/mica.20260918-0100" && sha256sum mica-build.lock mica-index.json >SHA256SUMS)
if out="$(index_env bash tools/release.sh verify-index mica.20260918-0100 2>&1)"; then
    fail "verify-index accepted an index whose built row differs from its referenced lock"
elif printf '%s' "${out}" | grep -F "mica-build.lock of mica.20260918-0100 differs from the index rebuilt from its references" >/dev/null; then
    pass "verify-index refuses an index whose copied row differs from the referenced lock"
else
    fail "verify-index refused, but not naming the difference: $(printf '%s' "${out}" | tail -3)"
fi

# --- 5. The plan once an index exists: each product's previous release from the newest index's entries and every
# scoped release later than that index (a pending index job lags behind), never from older releases.
IDS="$(awk -F'\t' '$1 == "product" { print $7 "\t" $8 }' "${DIR}/mica-build.lock")"
rm -rf "${IDX}/history/mica.20260918-0100"
mkdir -p "${IDX}/history/uefi-x64.20260915-0000"
printf 'not a lock\n' >"${IDX}/history/uefi-x64.20260915-0000/mica-build.lock"
# Both scopes hold one indexed product, so neither falls back to the full history, and the broken older
# release above proves that no older release is read.
if [ "$(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-x64-dev.20260919-0000 2>&1)" = "uefi-x64-dev	uefi-x64	3	${B}	${IDS}" ] &&
    [ "$(MICA_RELEASE_HISTORY="${IDX}/history" release plan cx3576-prod.20260919-0000 2>&1)" = "cx3576-prod	cx3576	2	${C}	${IDS}" ]; then
    pass "the plan takes a scoped release later than the newest index over its entry, another product's previous release from the index entry, and reads no older release"
else
    fail "plan after an index: $(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-x64-dev.20260919-0000 2>&1 | tail -3); $(MICA_RELEASE_HISTORY="${IDX}/history" release plan cx3576-prod.20260919-0000 2>&1 | tail -3)"
fi
mv "${IDX}/history/uefi-x64.20260918-0000" "${IDX}/aside/history/"
if [ "$(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-x64-dev.20260919-0000 2>&1)" = "uefi-x64-dev	uefi-x64	2	${A}	${IDS}" ]; then
    pass "with no release later than the index, the plan is the index entry's"
else
    fail "plan from the index alone: $(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-x64-dev.20260919-0000 2>&1 | tail -3)"
fi
rm -rf "${IDX}/history/uefi-x64.20260915-0000"
fabricate uefi-arm64-dev.20260916-0300 uefi-arm64-dev 5
if [ "$(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-arm64-dev.20260919-0000 2>&1)" = "uefi-arm64-dev	uefi-arm64	6	uefi-arm64-dev.20260916-0300	${IDS}" ]; then
    pass "a product outside the newest index with an older release plans one generation above that release, from the full history"
else
    fail "plan of a product outside the index: $(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-arm64-dev.20260919-0000 2>&1 | tail -3)"
fi
rm -rf "${IDX}/history/uefi-arm64-dev.20260916-0300"
if [ "$(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-arm64-dev.20260919-0000 2>&1)" = "uefi-arm64-dev	uefi-arm64	2	-	-	-" ]; then
    pass "a product never released plans generation 2 once an index exists"
else
    fail "plan of a product never released: $(MICA_RELEASE_HISTORY="${IDX}/history" release plan uefi-arm64-dev.20260919-0000 2>&1 | tail -3)"
fi
printf '\n' >>"${IDX}/history/mica.20260917-0000/mica-build.lock"
MICA_RELEASE_HISTORY="${IDX}/history" expect_refusal "a plan over a tampered index" "release mica.20260917-0000: SHA256SUMS does not list exactly its mica-build.lock and mica-index.json" plan uefi-x64.20260919-0000
cp "${L}" "${IDX}/history/mica.20260917-0000/"

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
