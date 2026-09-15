#!/usr/bin/env bash
# One product, one closure: from the product's recipe to its signed image,
# under _out/products/<name>/, reusing the result when nothing it was built
# from has changed.
#
#   bash tools/product-build.sh <name>            build (or reuse) the product
#   bash tools/product-build.sh <name> --verify   verify its image against the contract
#   bash tools/product-build.sh <name> --release <YYYYMMDD-HHMM>
#                                                 build it as that release: the components are versioned
#                                                 with the release name, a dirty tree is refused, and the
#                                                 gated release directory is assembled for the development
#                                                 channel (release/)
#
#   reads   products/<name>/ (tools/product.sh), locks/, _out/boards/<board>/ (make board-fetch),
#           _out/debs/<arch>/ (tools/pool.sh), the signing workspace (MICA_SIGNING_OUTPUT, default meta/)
#   writes  _out/products/<name>/{receipt.txt,lifecycle/,root/,kernel/,firmware/,deployments/,records.json,image/,update.micaupd}
#
# THE STEPS, in the order the components depend on one another:
#   fetch     the product's closure out of the pool of the board's architecture, and the board bundle
#   compose   the root (rootfs/build.sh, MICA_PRODUCT), into _out/<board>/
#   root      the signed root component out of that composition
#   kernel    the signed kernel/support component out of the bundle and the pinned lifecycle binaries
#   firmware  the signed firmware package: built and signed (efi) or the bundle's loader (a FIT board)
#   deploy    two signed factory deployment records, generations 1 and 2
#   image     every IMAGE_KIND the product names (disk; rockchip-update is 20260912-2251 and refused)
#   archive   the signed update archive of generation 2
#
# THE RECEIPT is the sha256 of everything the build read: the product
# directory, every pin, the board's board.env and kernel release, the
# public certificates of the three signing domains and the tree's commit.
# A product whose receipt matches the one on disk and whose image exists is
# not rebuilt; a changed input rebuilds it whole (the components bind one
# another by identity, so a partial rebuild would be a different product
# with an old name).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
cd "${REPO_ROOT}"
NAME="${1:-}"
MODE="${2:-build}"
RELEASE=""
[ -n "${NAME}" ] || { echo "usage: bash tools/product-build.sh <name> [--verify | --release <YYYYMMDD-HHMM>]" >&2; exit 1; }
if [ "${MODE}" = --release ]; then
    RELEASE="${3:-}"
    [[ "${RELEASE}" =~ ^[0-9]{8}-[0-9]{4}$ ]] || { echo "error: --release takes the UTC release name YYYYMMDD-HHMM" >&2; exit 1; }
    [ -z "$(git status --porcelain)" ] || { echo "error: a release is built from a clean checkout of its tag; this tree is dirty" >&2; exit 1; }
    CI=1 python3 tools/locks.py check >/dev/null || { echo "error: locks/ holds an offline pin (tools/local-pins.sh) or breaks a rule (see above); a release imports published releases only" >&2; exit 1; }
    MODE=build
fi
SIGNING="${MICA_SIGNING_OUTPUT:-${REPO_ROOT}/meta}"
OUT="${REPO_ROOT}/_out/products/${NAME}"

# The product, validated against its fetched board; the board is fetched
# first so a fresh clone gets a refusal that names the fetch, not a path.
BOARD_NAME="$(sed -n 's/^BOARD=//p' "products/${NAME}/product.env" | head -1 | tr -d '"')"
[ -n "${BOARD_NAME}" ] || { echo "error: products/${NAME}/product.env declares no BOARD (or the product does not exist; the products are: $(bash tools/product.sh --list | tr '\n' ' '))" >&2; exit 1; }
[ -f "_out/boards/${BOARD_NAME}/board.env" ] || bash tools/board-pool.sh --fetch "${BOARD_NAME}"
eval "$(bash tools/product.sh "${NAME}")"
env_value() { sed -n "s/^$2=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$1" | head -1; }
# The kernel directory of the product's profile: kernel/<profile> on a FIT board, kernel on a UEFI board.
KERNEL_DIR="$(bash tools/board-pool.sh --kernel-dir "${BOARD}" "${PROFILE}")"
BOOT_BACKEND="$(env_value "${BOARD_DIR}/board.env" BOOT_BACKEND)"
UBOOT_BIN_NAME="$(env_value "${BOARD_DIR}/board.env" UBOOT_BIN_NAME)"

# The signing inputs: public certificates enter the build, private keys sign.
for f in verity/signer.key.pem verity/signer.cert.pem boot/signer.key.pem boot/signer.cert.pem updates/signer.key.pem updates/public.key; do
    [ -f "${SIGNING}/${f}" ] || { echo "error: ${SIGNING}/${f} does not exist; the signing workspace is incomplete (development inputs: make os-devkeys)" >&2; exit 1; }
done
PUBLIC_KEY="$(tr -d '\n' <"${SIGNING}/updates/public.key")"

if [ "${MODE}" = --verify ]; then
    # The image is the one SHA256SUMS names; the directory also holds the
    # partition images the assembler built it from.
    image="${OUT}/image/$(awk 'NR == 1 { print $2 }' "${OUT}/image/SHA256SUMS" 2>/dev/null || true)"
    [ -n "${image##*/}" ] && [ -f "${image}" ] || { echo "error: ${OUT}/image holds no image; build the product first (make product PRODUCT=${NAME})" >&2; exit 1; }
    exec bash verify/run.sh --verify --board "${BOARD}" --image "${image}" --public-key "${SIGNING}/updates/public.key"
fi
[ "${MODE}" = build ] || { echo "usage: bash tools/product-build.sh <name> [--verify | --release <YYYYMMDD-HHMM>]" >&2; exit 1; }

# Every image kind has a packer, refused before anything is built (tools/image-kinds.sh).
bash tools/image-kinds.sh check ${IMAGE_KINDS}

# The receipt: what this build reads.
receipt() {
    {
        find "products/${NAME}" -type f | sort | xargs sha256sum
        find locks deps -type f 2>/dev/null | sort | xargs sha256sum
        sha256sum "${BOARD_DIR}/board.env" "${KERNEL_DIR}/kernel.release" "${KERNEL_DIR}/config"
        sha256sum "${SIGNING}/verity/signer.cert.pem" "${SIGNING}/boot/signer.cert.pem" "${SIGNING}/updates/public.key"
        printf 'tree %s%s\n' "$(git rev-parse HEAD)" "$([ -z "$(git status --porcelain)" ] || printf ' dirty')"
        printf 'release %s\n' "${RELEASE:-none}"
    } | sed "s|${REPO_ROOT}/||"
}
WANT="$(receipt)"
if [ -f "${OUT}/receipt.txt" ] && [ "$(cat "${OUT}/receipt.txt")" = "${WANT}" ] && [ -f "${OUT}/image/SHA256SUMS" ]; then
    echo "product: ${NAME} is up to date -- every input in ${OUT}/receipt.txt is unchanged and the image exists; nothing to do"
    awk -v d="${OUT}/image/" '{ print d $2 }' "${OUT}/image/SHA256SUMS"
    exit 0
fi
case "${WANT}" in *' dirty'*) echo "note: the tree is dirty; this build is recorded as such and is not a release candidate" ;; esac

# THE CLOSURE, resolved before anything is fetched: the resolver reads the
# pins and the bundle's manifests, not the pool, so the pool can be fetched
# for exactly what this product installs, plus the archives the components
# read -- the lifecycle binaries and the unsigned loader.
echo "=== product ${NAME}: fetch (board ${BOARD}, ${MICA_ARCH}) ==="
CLOSURE="$(bash rootfs/packages/resolve.sh --board "${BOARD}" --board-dir "${BOARD_DIR}/manifests" --features "${FEATURES}" --components "${COMPONENTS}" | tr '\n' ' ')"
bash tools/pool.sh fetch --arch "${MICA_ARCH}" --packages "${CLOSURE} mica-lifecycle mica-systemd-boot"
bash tools/source.sh mica-system-base
bash tools/pool.sh index --arch "${MICA_ARCH}"
bash tools/board-pool.sh --fetch "${BOARD}"

echo "=== product ${NAME}: compose ==="
MICA_PRODUCT="${NAME}" bash rootfs/build.sh

# The composition (build/) stays; the components are made afresh.
for d in lifecycle fit-tools root kernel firmware deployments image records.json update.micaupd kinds.tsv release release-notes.md receipt.txt; do rm -rf "${OUT:?}/${d}"; done
mkdir -p "${OUT}/deployments"
VERSION="${RELEASE:-$(bash tools/version.sh)}"
echo "=== product ${NAME}: components at version ${VERSION} ==="
bash tools/deploy-pool.sh --lifecycle "${MICA_ARCH}" "${OUT}/lifecycle"
bash build/run.sh --components root --input "${OUT}/build" --arch "${MICA_ARCH}" --version "${VERSION}" --out "${OUT}/root" \
    --content-key "${SIGNING}/verity/signer.key.pem" --content-cert "${SIGNING}/verity/signer.cert.pem"
# THE PACKAGER, built from the pinned boot/ tree before the kernel component
# runs in it: a UEFI board's boot-tools image for its EFI architecture, a FIT
# board's fit-tools image over the board's own mkimage (uboot/tools in the
# bundle). docker's cache makes an unchanged image free; what this refuses to
# inherit is a local tag left behind by an older boot/ tree, which packaged
# with the wrong tool names until the next hand-run make os-boot-tools.
# build-tools.sh names its target as UEFI names the architecture (X64, AA64),
# in lower case.
efi_target() { case "$1" in amd64) echo X64 ;; arm64) echo AA64 ;; *) echo "error: no EFI architecture for $1" >&2; exit 1 ;; esac | tr '[:upper:]' '[:lower:]'; }
if [ "${BOOT_BACKEND}" = uboot-fit ]; then
    bash boot/build-tools.sh --target "$(efi_target amd64)"
    # The bundle's files are all 0644 (a board archive ships data, not
    # executables); the packager runs these four, so they are staged executable.
    rm -rf "${OUT}/fit-tools"; mkdir -p "${OUT}/fit-tools"
    for t in mkimage fit_check_sign fdt_add_pubkey dumpimage; do install -m 0755 "${BOARD_DIR}/uboot/tools/${t}" "${OUT}/fit-tools/${t}"; done
    # The signed regulatory database, pinned in locks/upstream.lock.
    IFS=$'\t' read -r _ _ _ _ REGDB_SHA256 REGDB_URL < <(python3 tools/locks.py rows source upstream.lock | awk -F'\t' '$2 == "wireless-regdb"') || true
    [ -n "${REGDB_URL:-}" ] || { echo "error: locks/upstream.lock has no source row for wireless-regdb" >&2; exit 1; }
    docker build --label ai-agent=true -t ai-agent/mica-fit-tools-amd64 --build-arg MICA_BOOT_TOOLS=ai-agent/mica-boot-tools-amd64 \
        --build-arg "REGDB_URL=${REGDB_URL}" --build-arg "REGDB_SHA256=${REGDB_SHA256}" \
        --build-context "fit-tools=${OUT}/fit-tools" -f boot/Dockerfile.fit boot
else
    bash boot/build-tools.sh --target "$(efi_target "${MICA_ARCH}")"
fi
bash build/run.sh --components kernel --board "${BOARD}" --profile "${PROFILE}" --input "${KERNEL_DIR}" \
    --runkit "${OUT}/lifecycle/mica-runkit" --public-key "${PUBLIC_KEY}" --out "${OUT}/kernel" \
    --content-key "${SIGNING}/verity/signer.key.pem" --content-cert "${SIGNING}/verity/signer.cert.pem" \
    --boot-key "${SIGNING}/boot/signer.key.pem" --boot-cert "${SIGNING}/boot/signer.cert.pem"
if [ "${BOOT_BACKEND}" = uboot-fit ]; then
    [ -n "${UBOOT_BIN_NAME}" ] && [ -f "${BOARD_DIR}/uboot/${UBOOT_BIN_NAME}" ] || { echo "error: the ${BOARD} bundle carries no uboot/${UBOOT_BIN_NAME:-?}; a FIT board's firmware is its loader" >&2; exit 1; }
    bash build/run.sh --components firmware --board "${BOARD}" --out "${OUT}/firmware" --metadata-key "${SIGNING}/updates/signer.key.pem" \
        --generation 1 --version "${VERSION}" --input "${BOARD_DIR}/uboot/${UBOOT_BIN_NAME}"
else
    bash build/run.sh --components firmware --board "${BOARD}" --out "${OUT}/firmware" --metadata-key "${SIGNING}/updates/signer.key.pem" \
        --generation 1 --version "${VERSION}" --boot-key "${SIGNING}/boot/signer.key.pem" --boot-cert "${SIGNING}/boot/signer.cert.pem"
fi
for generation in 1 2; do
    bash build/run.sh --components deployment --kernel "${OUT}/kernel" --root "${OUT}/root" --generation "${generation}" --version "${VERSION}" \
        --metadata-key "${SIGNING}/updates/signer.key.pem" --out "${OUT}/deployments/${generation}.json"
done
python3 - "${OUT}" <<'PY'
import json, sys
out = sys.argv[1]
records = [{'envelope': open(f'{out}/deployments/{g}.json').read(), 'kernelDirectory': f'{out}/kernel', 'rootDirectory': f'{out}/root'} for g in (1, 2)]
json.dump(records, open(f'{out}/records.json', 'w'))
PY
echo "=== product ${NAME}: image ==="
bash build/run.sh --components image --board "${BOARD}" --records "${OUT}/records.json" --public-key "${PUBLIC_KEY}" \
    --firmware "${OUT}/firmware" --out "${OUT}/image" ${PROVISIONING:+--provisioning "${PROVISIONING}"}
bash build/run.sh --components archive --input "${OUT}/deployments/2.json" --kernel "${OUT}/kernel" --root "${OUT}/root" \
    --public-key "${PUBLIC_KEY}" --out "${OUT}/update.micaupd"
# The flashing formats of the product's image kinds, one packer each; kinds.tsv names their outputs.
bash tools/image-kinds.sh pack "${OUT}" ${IMAGE_KINDS}
if [ -n "${RELEASE}" ]; then
    # THE CHANNEL IS DEVELOPMENT, stated here and nowhere else (user decision
    # 2026-09-14): releases sign with the development trust material, and the
    # release gate refuses development-marked material on the candidate and
    # stable channels (build/src/release-manifest.ts), which stays so. A
    # customer channel is a change to this line together with production keys.
    echo "=== product ${NAME}: release ${RELEASE}, development channel ==="
    rm -rf "${OUT}/release"
    printf '# Mica OS %s\n\nProduct %s (board %s, profile %s), development channel.\n' "${RELEASE}" "${NAME}" "${BOARD}" "${PROFILE}" >"${OUT}/release-notes.md"
    image="$(awk 'NR == 1 { print $2 }' "${OUT}/image/SHA256SUMS")"
    bash build/run.sh --release assemble --channel development --profile "${PROFILE}" --board "${BOARD}" --version "${RELEASE}" \
        --image "${OUT}/image/${image}" --update "${OUT}/update.micaupd" --firmware "${OUT}/firmware" \
        --package-manifest "${OUT}/build/rootfs-packages.txt" --runtime-report "${OUT}/build/rootfs-report.runtime.json" \
        --baked-meta "${OUT}/build/compose/meta-public/usr/share/mica/meta" --notes "${OUT}/release-notes.md" \
        --out "${OUT}/release" --public-key "${SIGNING}/updates/public.key"
    bash build/run.sh --release gate --dir "${OUT}/release" --public-key "${SIGNING}/updates/public.key"
fi
printf '%s\n' "${WANT}" >"${OUT}/receipt.txt"
echo "=== product ${NAME}: done ==="
awk -v d="${OUT}/image/" '{ print d $2 }' "${OUT}/image/SHA256SUMS"; ls -1 "${OUT}/update.micaupd"
