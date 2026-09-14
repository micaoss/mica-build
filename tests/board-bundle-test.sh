#!/usr/bin/env bash
# tools/board-pool.sh's bundle rules over fixture bundles: a uboot-fit board
# carries kernel/dev and kernel/prod and no kernel/ of its own, a systemd-boot
# board one kernel/, and --kernel-dir names the directory a product of each
# profile packs. --fetch reads a fixture board artifact through a `curl` on PATH
# that answers the ghcr.io token, manifest and blob endpoints from files.
#
#   bash tests/board-bundle-test.sh      (make os-board-bundle-test; no network, no docker)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SCRATCH="${REPO_ROOT}/tmp/board-bundle-test.$$"
mkdir -p "${SCRATCH}"
trap 'rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

printf 'fixture certificate\n' >"${SCRATCH}/cert.pem"
export MICA_VERITY_TRUST_CERT="${SCRATCH}/cert.pem" MICA_BOARDS_OUT="${SCRATCH}/boards"

# bundle <board> <backend> <kernel dir>...
bundle() {
    local dir="${SCRATCH}/boards/$1" d
    rm -rf "${dir}"
    mkdir -p "${dir}/manifests" "${dir}/trust"
    printf 'LAYOUT_BOARD=%s\nBOOT_BACKEND=%s\n' "$1" "$2" >"${dir}/board.env"
    : >"${dir}/manifests/board.pkgs"
    cp "${SCRATCH}/cert.pem" "${dir}/trust/verity-signer.cert.pem"
    shift 2
    for d in "$@"; do
        mkdir -p "${dir}/${d}"
        for f in config kernel.release modules.tar; do printf '%s\n' "${d}" >"${dir}/${d}/${f}"; done
    done
    printf '%s\n' "${dir}"
}
accepts() { # <label> <dir>
    if out="$(bash tools/board-pool.sh --check "$2" 2>&1)"; then pass "$1"; else fail "$1: ${out}"; fi
}
refuses() { # <label> <fragment> <dir>
    if out="$(bash tools/board-pool.sh --check "$3" 2>&1)"; then
        fail "$1: accepted"
    elif printf '%s' "${out}" | grep -F -- "$2" >/dev/null; then
        pass "$1: refused naming '$2'"
    else
        fail "$1: refused, but not naming '$2': ${out}"
    fi
}

accepts "a FIT bundle with kernel/dev and kernel/prod" "$(bundle fitboard uboot-fit kernel/dev kernel/prod)"
refuses "a FIT bundle without its prod kernel" "carries no kernel/prod/config" "$(bundle fitboard uboot-fit kernel/dev)"
refuses "a FIT bundle with a kernel/ of its own" "with a kernel/ of its own" "$(bundle fitboard uboot-fit kernel kernel/dev kernel/prod)"
refuses "a FIT bundle with only the old single kernel" "carries no kernel/dev/config" "$(bundle fitboard uboot-fit kernel)"
accepts "a UEFI bundle with one kernel/" "$(bundle efiboard systemd-boot kernel)"
refuses "a UEFI bundle with profile kernels" "with profile kernel directories" "$(bundle efiboard systemd-boot kernel kernel/dev)"
refuses "a bundle with no known boot backend" "names no BOOT_BACKEND" "$(bundle oddboard grub kernel)"
dir="$(bundle fitboard uboot-fit kernel/dev kernel/prod)"
printf 'another certificate\n' >"${dir}/trust/verity-signer.cert.pem"
refuses "a bundle built against another verity certificate" "verity trust certificate that is not" "${dir}"

bundle fitboard uboot-fit kernel/dev kernel/prod >/dev/null
bundle efiboard systemd-boot kernel >/dev/null
for pair in "fitboard dev ${SCRATCH}/boards/fitboard/kernel/dev" "fitboard prod ${SCRATCH}/boards/fitboard/kernel/prod" \
    "efiboard dev ${SCRATCH}/boards/efiboard/kernel" "efiboard prod ${SCRATCH}/boards/efiboard/kernel"; do
    set -- ${pair}
    got="$(bash tools/board-pool.sh --kernel-dir "$1" "$2" 2>&1 || true)"
    [ "${got}" = "$3" ] && pass "--kernel-dir $1 $2 is ${3#"${SCRATCH}"/}" || fail "--kernel-dir $1 $2 printed ${got}, not $3"
done
if bash tools/board-pool.sh --kernel-dir fitboard staging >/dev/null 2>&1; then fail "--kernel-dir accepted the profile 'staging'"; else pass "--kernel-dir refuses a profile other than dev or prod"; fi

# --fetch: the board artifact of an oci record, by digest.
FIX="${SCRATCH}/registry"; SHIM="${SCRATCH}/bin"; REG="micaoss/fixture-boards"
COMMIT="$(printf 'd%.0s' $(seq 40))"
mkdir -p "${SHIM}"
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
https://ghcr.io/token\?*) file="${BUNDLE_TEST_REGISTRY}/token.json" ;;
https://ghcr.io/v2/*) file="${BUNDLE_TEST_REGISTRY}/${url#https://ghcr.io/v2/}" ;;
*) file="" ;;
esac
code=404
if [ -n "${file}" ] && [ -f "${file}" ]; then code=200; cp "${file}" "${out}"; fi
[ -z "${fmt}" ] || printf '%s' "${code}"
CURL
chmod 0755 "${SHIM}/curl"
sha() { sha256sum "$1" | cut -d' ' -f1; }

# artifact [jq filter]: publish the fitboard bundle as its board artifact, and the pin and record naming it.
artifact() {
    local tree="${SCRATCH}/artifact" layers="[]" f digest
    rm -rf "${FIX}" "${tree}" "${SCRATCH}/pins" "${SCRATCH}/releases" "${SCRATCH}/cache" "${SCRATCH}/boards"
    mkdir -p "${FIX}/${REG}/blobs" "${FIX}/${REG}/manifests" "${SCRATCH}/pins" "${SCRATCH}/releases"
    printf '{"token":"fixture"}\n' >"${FIX}/token.json"
    cp -a "$(bundle fitboard uboot-fit kernel/dev kernel/prod)" "${tree}"
    mkdir -p "${tree}/firmware/vendor"; printf 'blob\n' >"${tree}/firmware/vendor/fw.bin"
    (cd "${tree}" && tar -cf firmware.tar firmware && rm -rf firmware)
    while IFS= read -r f; do
        digest="$(sha "${tree}/${f}")"
        cp "${tree}/${f}" "${FIX}/${REG}/blobs/sha256:${digest}"
        layers="$(jq -c --arg t "${f}" --arg d "sha256:${digest}" '. + [{mediaType: "application/vnd.mica.board.file", digest: $d, size: 1, annotations: {"org.opencontainers.image.title": $t}}]' <<<"${layers}")"
    done < <(cd "${tree}" && find . -type f -printf '%P\n' | LC_ALL=C sort)
    jq -n --argjson l "${layers}" --arg c "${COMMIT}" --arg cert "$(sha "${SCRATCH}/cert.pem")" '{schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/vnd.mica.board", config: {mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2}, layers: $l, annotations: {"mica.source-repo": "fixture-boards", "mica.source-commit": $c, "org.opencontainers.image.revision": $c, "mica.board": "fitboard", "mica.arch": "arm64", "mica.verity-cert-sha256": $cert}}' | jq "${1:-.}" >"${SCRATCH}/manifest.json"
    digest="sha256:$(sha "${SCRATCH}/manifest.json")"
    cp "${SCRATCH}/manifest.json" "${FIX}/${REG}/manifests/${digest}"
    jq -n --arg c "${COMMIT}" '{name: "mica-kernel-fitboard", repository: "fixture-boards", commit: $c, targets: {arm64: {version: "1.0.0+gitdddddddddddd-1", architecture: "arm64", sha256: ("0" * 64), asset: "mica-kernel-fitboard_1.0.0.gitdddddddddddd-1_arm64.deb"}}}' >"${SCRATCH}/pins/mica-kernel-fitboard.json"
    jq -n --arg c "${COMMIT}" --arg b "ghcr.io/${REG}:board.fitboard.20260914-0001@${digest}" '{repository: "fixture-boards", release: "20260914-0001", commit: $c, transport: "oci", url: "https://github.com/micaoss/fixture-boards/releases/download/20260914-0001/", sha256sums: ("0" * 64), pools: {}, boards: {fitboard: $b}}' >"${SCRATCH}/releases/fixture-boards.json"
}
fetch() {
    PATH="${SHIM}:${PATH}" BUNDLE_TEST_REGISTRY="${FIX}" MICA_LOCK_DIR="${SCRATCH}/pins" MICA_RELEASE_DIR="${SCRATCH}/releases" \
        MICA_OCI_CACHE="${SCRATCH}/cache/oci" MICA_BOARD_CACHE="${SCRATCH}/cache/boards" bash tools/board-pool.sh --fetch fitboard
}
fetch_refuses() { # <label> <fragment>
    if out="$(fetch 2>&1)"; then
        fail "$1: accepted"
    elif printf '%s' "${out}" | grep -F -- "$2" >/dev/null; then
        pass "$1: refused naming '$2'"
    elif [ -d "${SCRATCH}/boards/fitboard" ]; then
        fail "$1: refused, but left _out/boards/fitboard behind"
    else
        fail "$1: refused, but not naming '$2': ${out}"
    fi
}
artifact
if out="$(fetch 2>&1)" && [ -f "${SCRATCH}/boards/fitboard/firmware/vendor/fw.bin" ] && [ ! -e "${SCRATCH}/boards/fitboard/firmware.tar" ] \
    && cmp -s "${SCRATCH}/boards/fitboard/kernel/prod/config" "${SCRATCH}/artifact/kernel/prod/config"; then
    pass "--fetch places every layer at its title and unpacks firmware.tar into firmware/"
else
    fail "--fetch of a valid board artifact: ${out}"
fi
artifact '.annotations["mica.verity-cert-sha256"] = ("0" * 64)'
fetch_refuses "a board artifact built against another verity certificate" "verity trust certificate that is not"
artifact '.annotations["mica.source-commit"] = ("e" * 40)'
fetch_refuses "a board artifact of another commit" "is not the board artifact of fitboard"
artifact '.layers[0].annotations["org.opencontainers.image.title"] = "../board.env"'
fetch_refuses "a layer titled outside the bundle" "a layer title is not a relative path"
artifact
(cd "${SCRATCH}" && mkdir -p escape && printf 'x\n' >escape/x && tar -cf "${SCRATCH}/evil.tar" escape)
digest="$(sha "${SCRATCH}/evil.tar")"; cp "${SCRATCH}/evil.tar" "${FIX}/${REG}/blobs/sha256:${digest}"
artifact "(.layers[] | select(.annotations[\"org.opencontainers.image.title\"] == \"firmware.tar\") | .digest) = \"sha256:${digest}\""
cp "${SCRATCH}/evil.tar" "${FIX}/${REG}/blobs/sha256:${digest}"
fetch_refuses "a firmware.tar member outside firmware/" "holds a member outside firmware/"

# --fetch over a local record (tools/local-pins.sh): the bundle out of the checkout's own kernel archive.
local_fixture() { # [archive bytes other than the pin]
    local checkout="${SCRATCH}/checkout" tree="${SCRATCH}/deb-tree" deb
    rm -rf "${checkout}" "${tree}" "${SCRATCH}/pins" "${SCRATCH}/releases" "${SCRATCH}/boards"
    mkdir -p "${checkout}/_out/debs/arm64/pool" "${tree}/usr/lib/mica/board" "${SCRATCH}/pins" "${SCRATCH}/releases"
    cp -a "$(bundle fitboard uboot-fit kernel/dev kernel/prod)" "${tree}/usr/lib/mica/board/fitboard"
    rm -rf "${SCRATCH}/boards"
    deb="${checkout}/_out/debs/arm64/pool/mica-kernel-fitboard_1.0.0+gitdddddddddddd-1_arm64.deb"
    python3 - "${tree}" "${deb}" <<'PY'
import io, sys, tarfile
tree, out = sys.argv[1], sys.argv[2]
data = io.BytesIO()
with tarfile.open(fileobj=data, mode='w:gz') as tar:
    tar.add(tree + '/usr', arcname='./usr')
def member(name, body):
    head = f'{name:<16}{0:<12}{0:<6}{0:<6}{100644:<8}{len(body):<10}`\n'.encode()
    return head + body + (b'\n' if len(body) % 2 else b'')
open(out, 'wb').write(b'!<arch>\n' + member('debian-binary', b'2.0\n') + member('data.tar.gz', data.getvalue()))
PY
    jq -n --arg c "${COMMIT}" --arg s "$(sha "${deb}")" '{name: "mica-kernel-fitboard", repository: "fixture-boards", commit: $c, targets: {arm64: {version: "1.0.0+gitdddddddddddd-1", architecture: "arm64", sha256: $s, asset: "mica-kernel-fitboard_1.0.0.gitdddddddddddd-1_arm64.deb"}}}' >"${SCRATCH}/pins/mica-kernel-fitboard.json"
    jq -n --arg c "${COMMIT}" --arg d "${checkout}" '{repository: "fixture-boards", commit: $c, transport: "local", checkout: $d}' >"${SCRATCH}/releases/fixture-boards.json"
    [ -z "${1:-}" ] || printf 'other bytes\n' >>"${deb}"
}
local_fixture
if out="$(GITHUB_ACTIONS='' fetch 2>&1)" && cmp -s "${SCRATCH}/boards/fitboard/kernel/dev/config" "${SCRATCH}/deb-tree/usr/lib/mica/board/fitboard/kernel/dev/config"; then
    pass "--fetch over a local record reads the bundle out of the checkout's kernel archive"
else
    fail "--fetch over a local record: ${out}"
fi
local_fixture
GITHUB_ACTIONS=true fetch_refuses "a local record under GitHub Actions" "is a local record"
local_fixture changed
GITHUB_ACTIONS='' fetch_refuses "a local kernel archive other than the pin" "is not the archive deps/packages/mica-kernel-fitboard.json pins"

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
