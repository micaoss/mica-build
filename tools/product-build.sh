#!/usr/bin/env bash
# One product, one closure: from the product's recipe to its signed image,
# under _out/products/<name>/, reusing the result when nothing it was built
# from has changed.
#
#   bash tools/product-build.sh <name>            build (or reuse) the product
#   bash tools/product-build.sh <name> --verify   verify its image against the contract
#   bash tools/product-build.sh <name> --release <YYYYMMDD-HHMM> [--generation <g>]
#                                                 build it as that release: the components are versioned
#                                                 with the release name, a dirty tree is refused, and the
#                                                 gated release directory is assembled for the development
#                                                 channel (release/); the release's deployment is generation
#                                                 <g> (default 2, at least 2), one above its previous release's
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
#   deploy    two signed factory deployment records, generations <g>-1 and <g>
#   image     every IMAGE_KIND the product names (disk; rockchip-update is 20260912-2251 and refused)
#   archive   the signed update archives of generation <g>
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
GENERATION=2
[ -n "${NAME}" ] || { echo "usage: bash tools/product-build.sh <name> [--verify | --release <YYYYMMDD-HHMM> [--generation <g>]]" >&2; exit 1; }
if [ "${MODE}" = --release ]; then
    RELEASE="${3:-}"
    [[ "${RELEASE}" =~ ^[0-9]{8}-[0-9]{4}$ ]] || { echo "error: --release takes the UTC release name YYYYMMDD-HHMM" >&2; exit 1; }
    if [ "$#" -gt 3 ]; then
        [ "$#" -eq 5 ] && [ "$4" = --generation ] && [[ "$5" =~ ^[1-9][0-9]*$ ]] && [ "$5" -ge 2 ] ||
            { echo "error: --release takes an optional --generation <g>, a decimal of at least 2" >&2; exit 1; }
        GENERATION="$5"
    fi
    [ -z "$(git status --porcelain)" ] || { echo "error: a release is built from a clean checkout of its tag; this tree is dirty" >&2; exit 1; }
    CI=1 python3 tools/locks.py check >/dev/null || { echo "error: locks/ holds an offline pin (tools/local-pins.sh) or breaks a rule (see above); a release imports published releases only" >&2; exit 1; }
    MODE=build
fi
SIGNING="${MICA_SIGNING_OUTPUT:-${REPO_ROOT}/meta}"
OUT="${REPO_ROOT}/_out/products/${NAME}"

# The product, validated against its fetched board; the board is fetched
# first so a fresh clone gets a refusal that names the fetch, not a path.
BOARD_NAME="$(sed -n 's/^BOARD=//p' "products/${NAME}/product.env" | sed -n '1p' | tr -d '"')"
[ -n "${BOARD_NAME}" ] || { echo "error: products/${NAME}/product.env declares no BOARD (or the product does not exist; the products are: $(bash tools/product.sh --list | tr '\n' ' '))" >&2; exit 1; }
[ -f "_out/boards/${BOARD_NAME}/board.env" ] || bash tools/board-pool.sh --fetch "${BOARD_NAME}"
eval "$(bash tools/product.sh "${NAME}")"
env_value() { sed -n "s/^$2=\"\{0,1\}\([^\"]*\)\"\{0,1\}$/\1/p" "$1" | sed -n '1p'; }
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
    # The connd contract the verifier compares against is read out of mica-core's source at its pinned release.
    bash tools/source.sh mica-core >/dev/null
    exec bash verify/run.sh --verify --board "${BOARD}" --image "${image}" --public-key "${SIGNING}/updates/public.key"
fi
[ "${MODE}" = build ] || { echo "usage: bash tools/product-build.sh <name> [--verify | --release <YYYYMMDD-HHMM>]" >&2; exit 1; }


# The receipt: what this build reads.
receipt() {
    {
        find "products/${NAME}" -type f | sort | xargs sha256sum
        find locks -type f | sort | xargs sha256sum
        sha256sum "${BOARD_DIR}/board.env" "${KERNEL_DIR}/kernel.release" "${KERNEL_DIR}/config"
        sha256sum "${SIGNING}/verity/signer.cert.pem" "${SIGNING}/boot/signer.cert.pem" "${SIGNING}/updates/public.key"
        printf 'tree %s%s\n' "$(git rev-parse HEAD)" "$([ -z "$(git status --porcelain)" ] || printf ' dirty')"
        printf 'release %s\n' "${RELEASE:-none}"
        printf 'generation %s\n' "${GENERATION}"
    } | sed "s|${REPO_ROOT}/||"
}
WANT="$(receipt)"
if [ -f "${OUT}/receipt.txt" ] && [ "$(cat "${OUT}/receipt.txt")" = "${WANT}" ] && [ -f "${OUT}/image/SHA256SUMS" ]; then
    echo "product: ${NAME} is up to date -- every input in ${OUT}/receipt.txt is unchanged and the image exists; nothing to do"
    awk -v d="${OUT}/image/" '{ print d $2 }' "${OUT}/image/SHA256SUMS"
    exit 0
fi
case "${WANT}" in *' dirty'*) echo "note: the tree is dirty; this build is recorded as such and is not a release candidate" ;; esac

# THE POOL of the board's architecture, whole: the source lineage requires every
# archive the locks pin for it (rootfs/runtime/source-lineage.py), and the
# composer installs only what the resolver selects out of it.
echo "=== product ${NAME}: fetch (board ${BOARD}, ${MICA_ARCH}) ==="
bash tools/pool.sh fetch --arch "${MICA_ARCH}"
bash tools/source.sh mica-system-base
bash tools/pool.sh index --arch "${MICA_ARCH}"
bash tools/board-pool.sh --fetch "${BOARD}"

echo "=== product ${NAME}: compose ==="
# THE VERSION THE COMPOSITION WRITES INTO THE ROOT'S IDENTITY, computed here
# rather than after the compose because /etc/issue and /usr/lib/os-release are
# written at compose time. Same expression the components use below, so the
# console, os-release and the signed components cannot disagree about which
# version this build is.
VERSION="${RELEASE:-$(bash tools/version.sh)}"
MICA_PRODUCT="${NAME}" MICA_VERSION="${VERSION}" bash rootfs/build.sh

# The composition (build/) stays; the components are made afresh.
for d in lifecycle fit-tools root kernel firmware deployments image records.json update.micaupd updates updates.tsv kinds kinds.tsv release release-notes.md release-packages.tsv receipt.txt; do rm -rf "${OUT:?}/${d}"; done
mkdir -p "${OUT}/deployments"
echo "=== product ${NAME}: components at version ${VERSION} ==="
bash tools/deploy-pool.sh --lifecycle "${MICA_ARCH}" "${OUT}/lifecycle"
bash build/run.sh --components root --input "${OUT}/build" --arch "${MICA_ARCH}" --out "${OUT}/root" \
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
    # The FIT packaging tools are linux/amd64 on every board and install the amd64 loader archive.
    bash tools/pool.sh fetch --arch amd64 --packages mica-systemd-boot
    bash boot/build-tools.sh --target "$(efi_target amd64)"
    # The bundle's files are all 0644 (a board archive ships data, not
    # executables); the packager runs these four, so they are staged executable.
    rm -rf "${OUT}/fit-tools"; mkdir -p "${OUT}/fit-tools"
    for t in mkimage fit_check_sign fdt_add_pubkey dumpimage; do install -m 0755 "${BOARD_DIR}/uboot/tools/${t}" "${OUT}/fit-tools/${t}"; done
    # The signed regulatory database, pinned in locks/upstream.lock.
    IFS=$'\t' read -r _ _ _ _ REGDB_SHA256 REGDB_URL < <(python3 tools/locks.py rows source upstream.lock | awk -F'\t' '$2 == "wireless-regdb"') || true
    [ -n "${REGDB_URL:-}" ] || { echo "error: locks/upstream.lock has no source row for wireless-regdb" >&2; exit 1; }
    # Its pinned inputs, as the label mica.boot.inputs the kernel component's buildId names (boot/build-tools.sh).
    FIT_INPUTS="$( {
        printf 'boot-tools %s\nregdb %s %s\n' "$(docker image inspect --format '{{index .Config.Labels "mica.boot.inputs"}}' ai-agent/mica-boot-tools-amd64)" "${REGDB_URL}" "${REGDB_SHA256}"
        (cd boot && sha256sum Dockerfile.fit fit.sh regdb.sh)
        (cd "${OUT}/fit-tools" && sha256sum mkimage fit_check_sign fdt_add_pubkey dumpimage)
    } | sha256sum | cut -d' ' -f1)"
    docker build --platform linux/amd64 --label ai-agent=true --label "mica.boot.inputs=${FIT_INPUTS}" -t ai-agent/mica-fit-tools-amd64 --build-arg MICA_BOOT_TOOLS=ai-agent/mica-boot-tools-amd64 \
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
for generation in $((GENERATION - 1)) "${GENERATION}"; do
    bash build/run.sh --components deployment --kernel "${OUT}/kernel" --root "${OUT}/root" --product "${NAME}" --generation "${generation}" --version "${VERSION}" \
        --metadata-key "${SIGNING}/updates/signer.key.pem" --out "${OUT}/deployments/${generation}.json"
done
python3 - "${OUT}" "${GENERATION}" <<'PY'
import json, sys
out = sys.argv[1]
records = [{'envelope': open(f'{out}/deployments/{g}.json').read(), 'kernelDirectory': f'{out}/kernel', 'rootDirectory': f'{out}/root'} for g in (int(sys.argv[2]) - 1, int(sys.argv[2]))]
json.dump(records, open(f'{out}/records.json', 'w'))
PY
echo "=== product ${NAME}: image ==="
bash build/run.sh --components image --board "${BOARD}" --records "${OUT}/records.json" --public-key "${PUBLIC_KEY}" \
    --firmware "${OUT}/firmware" --out "${OUT}/image" ${PROVISIONING:+--provisioning "${PROVISIONING}"}
bash build/run.sh --components archive --input "${OUT}/deployments/${GENERATION}.json" --kernel "${OUT}/kernel" --root "${OUT}/root" --kind full \
    --public-key "${PUBLIC_KEY}" --out "${OUT}/update.micaupd"
# The update packages of the product's update kinds (the board's images.tsv update rows): the one signed
# descriptor with every object (full), or only the root's or the kernel's; updates.tsv names them.
mkdir -p "${OUT}/updates"
: >"${OUT}/updates.tsv"
while IFS=$'\t' read -r kind _ _ suffix; do
    [ -n "${kind}" ] || continue
    file="updates/mica-${NAME}-${VERSION}.${suffix}"
    bash build/run.sh --components archive --input "${OUT}/deployments/${GENERATION}.json" --kernel "${OUT}/kernel" --root "${OUT}/root" --kind "${kind}" \
        --public-key "${PUBLIC_KEY}" --out "${OUT}/${file}"
    printf '%s\t%s\t%s\n' "${kind}" "${file}" "$(sha256sum "${OUT}/${file}" | cut -d' ' -f1)" >>"${OUT}/updates.tsv"
done < <(bash tools/image-kinds.sh updates "${BOARD_DIR}" ${UPDATE_KINDS})
# The flashing formats of the product's image kinds, each packed and verified by its board's packer
# (tools/image-kinds.sh; tools/product.sh already checked them against the board's images.tsv).
bash tools/image-kinds.sh pack "${OUT}" "${BOARD_DIR}" "${NAME}" "${VERSION}" "${PROFILE}" ${RELEASE:+--release} ${IMAGE_KINDS}
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
    # The package inventory the root ships, read out of the signed root: the composer rewrites
    # /usr/share/mica/manifest.tsv to the packages whose files the selection kept.
    tools_arch="${MICA_ARCH}"; [ "${BOOT_BACKEND}" != uboot-fit ] || tools_arch=amd64
    # mica-build-side: container-block -- unsquashfs runs in the boot tools image the kernel component was packed in.
    docker run --rm --label ai-agent=true --network none -v "${OUT}/root:/root-component:ro" "ai-agent/mica-boot-tools-${tools_arch}" \
        unsquashfs -cat /root-component/rootfs.img usr/share/mica/manifest.tsv >"${OUT}/release-packages.tsv"
    # mica-build-side: host
    bash build/run.sh --release assemble --channel development --profile "${PROFILE}" --board "${BOARD}" --version "${RELEASE}" \
        --image "${OUT}/image/${image}" --update "${OUT}/update.micaupd" --firmware "${OUT}/firmware" \
        --package-manifest "${OUT}/release-packages.tsv" --runtime-report "${OUT}/build/rootfs-report.runtime.json" \
        --baked-meta "${OUT}/build/compose/meta-public/usr/share/mica/meta" --notes "${OUT}/release-notes.md" \
        --out "${OUT}/release" --public-key "${SIGNING}/updates/public.key"
    bash build/run.sh --release gate --dir "${OUT}/release" --public-key "${SIGNING}/updates/public.key"
fi
printf '%s\n' "${WANT}" >"${OUT}/receipt.txt"
echo "=== product ${NAME}: done ==="
awk -v d="${OUT}/image/" '{ print d $2 }' "${OUT}/image/SHA256SUMS"; ls -1 "${OUT}/update.micaupd"
