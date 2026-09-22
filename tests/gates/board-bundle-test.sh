#!/usr/bin/env bash
# tools/board-pool.sh's bundle rules and its assembly of a board's bundle. The
# rules over fixture bundles: a uboot-fit board carries kernel/dev and
# kernel/prod and no kernel/ of its own, a systemd-boot board one kernel/, and
# --kernel-dir names the directory a product of each profile packs. The
# assembly over a scratch clone of this tree and its first board: the board and
# firmware components staged from the tree, the kernel from a local build under
# _out/<board>/ when there is one, else from the latest release that published it
# with the same inputs hash -- a file:// release listing and a `curl` on PATH
# that answers the ghcr.io token, manifest and blob endpoints from files -- and
# refused, by name, when neither is there or the published component is not
# this board's, this domain's or a well-formed one.
#
#   bash tests/gates/board-bundle-test.sh      (make os-board-bundle-test; no network, no docker)
set -euo pipefail
cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd)"
SCRATCH="${REPO_ROOT}/tmp/board-bundle-test.$$"
mkdir -p "${SCRATCH}"
trap 'rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
sha() { sha256sum "$1" | cut -d' ' -f1; }

printf 'fixture certificate\n' >"${SCRATCH}/cert.pem"
export MICA_VERITY_TRUST_CERT="${SCRATCH}/cert.pem" MICA_BOARDS_OUT="${SCRATCH}/boards"

# --- 1. The bundle rules over fixture bundles.
# bundle <board> <backend> <kernel dir>...
bundle() {
    local dir="${SCRATCH}/boards/$1" d
    rm -rf "${dir}"
    mkdir -p "${dir}/manifests" "${dir}/trust"
    printf 'LAYOUT_BOARD=%s\nBOOT_BACKEND=%s\n' "$1" "$2" >"${dir}/board.env"
    : >"${dir}/manifests/board.pkgs"
    printf '# mica-boards images v1\nimage\tdisk\tbuiltin\tmica-build-env:base\timg\n' >"${dir}/images.tsv"
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
rm -rf "${SCRATCH}/boards"

# --- 2. --fetch over a scratch clone of this tree and its first board (a UEFI board: one kernel/ of
# bzImage|Image, config, kernel.release, modules.tar and the fragment, as its outputs.tsv lists).
CLONE="${SCRATCH}/clone"
git clone -q "${REPO_ROOT}" "${CLONE}"
git ls-files -z | tar --null -T - -cf - | tar -xf - -C "${CLONE}"
git -C "${CLONE}" add -A
[ -z "$(git -C "${CLONE}" status --porcelain)" ] || git -C "${CLONE}" -c user.name=test -c user.email=test@example.invalid commit -qm "the working tree under test"
BOARD="$(bash tools/boards.sh list | while read -r b; do [ "$(bash tools/boards.sh boot "${b}")" = systemd-boot ] && { echo "${b}"; break; }; done)"
[ -n "${BOARD}" ] || { echo "error: boards/boards.tsv lists no systemd-boot board for this test to assemble" >&2; exit 1; }
ARCH="$(bash tools/boards.sh arch "${BOARD}")"
mkdir -p "${CLONE}/meta/verity"
cp "${SCRATCH}/cert.pem" "${CLONE}/meta/verity/signer.cert.pem"
export MICA_BOARDS_OUT="${CLONE}/_out/boards" MICA_OCI_CACHE="${SCRATCH}/cache/oci" MICA_BOARD_CACHE="${SCRATCH}/cache/boards"
KERNEL_FILES="$(bash tools/boards.sh files "${BOARD}" kernel | sed 's|^kernel/||')"
local_build() { # the kernel files under _out/<board>/kernel, as make <board>-kernel leaves them
    rm -rf "${CLONE}/_out/${BOARD}/kernel"; mkdir -p "${CLONE}/_out/${BOARD}/kernel"
    for f in ${KERNEL_FILES}; do printf 'local %s\n' "${f}" >"${CLONE}/_out/${BOARD}/kernel/${f}"; done
}
# MICA_SOURCE_REPO: the clone's origin is a path, and the registry name is this repository's.
fetch() { (cd "${CLONE}" && PATH="${SHIM}:${PATH}" BUNDLE_TEST_REGISTRY="${FIX}" MICA_SOURCE_REPO=mica-build MICA_RELEASE_LIST="file://${RELEASES}/releases.json" \
    MICA_RELEASE_DOWNLOAD="file://${RELEASES}/download" bash tools/board-pool.sh --fetch "${BOARD}"); }
fetch_refuses() { # <label> <fragment>
    if out="$(fetch 2>&1)"; then
        fail "$1: accepted"
    elif printf '%s' "${out}" | grep -F -- "$2" >/dev/null; then
        [ ! -d "${CLONE}/_out/boards/${BOARD}" ] && pass "$1: refused naming '$2'" || fail "$1: refused, but left _out/boards/${BOARD} behind"
    else
        fail "$1: refused, but not naming '$2': ${out}"
    fi
}
# The registry and the releases: a curl on PATH answers ghcr.io from files; the release listing is file://.
FIX="${SCRATCH}/registry"; SHIM="${SCRATCH}/bin"; RELEASES="${SCRATCH}/releases"; REG="micaoss/mica-build"
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
    https://* | file://*) url="$1"; shift ;;
    *) shift ;;
    esac
done
case "${url}" in
https://ghcr.io/token\?*) file="${BUNDLE_TEST_REGISTRY}/token.json" ;;
https://ghcr.io/v2/*) file="${BUNDLE_TEST_REGISTRY}/${url#https://ghcr.io/v2/}" ;;
file://*) file="${url#file://}" ;;
*) file="" ;;
esac
code=404
if [ -n "${file}" ] && [ -f "${file}" ]; then code=200; [ -z "${out}" ] && cat "${file}" || cp "${file}" "${out}"; fi
[ -z "${fmt}" ] || printf '%s' "${code}"
[ "${code}" = 200 ] || [ -z "${out}" ] || exit 22
CURL
chmod 0755 "${SHIM}/curl"
INPUTS="$(cd "${CLONE}" && VERITY_TRUST_CERT="${CLONE}/meta/verity/signer.cert.pem" bash tools/inputs.sh "${BOARD}" kernel)"
# publish <label> [<jq filter over the manifest>] [<file edit>]: the kernel component of the board in the
# fixture registry, and a release <label> whose lock names it.
publish() {
    local label="$1" filter="${2:-.}" tree="${SCRATCH}/artifact" f layers="[]" digest
    rm -rf "${FIX}" "${tree}" "${RELEASES}"; mkdir -p "${FIX}/${REG}/blobs" "${FIX}/${REG}/manifests" "${tree}/kernel" "${RELEASES}/download/${label}"
    printf '{"token":"fixture"}\n' >"${FIX}/token.json"
    for f in ${KERNEL_FILES}; do printf 'published %s\n' "${f}" >"${tree}/kernel/${f}"; done
    [ -z "${3:-}" ] || (cd "${tree}" && eval "$3")
    while IFS= read -r f; do
        digest="$(sha "${tree}/${f}")"
        cp "${tree}/${f}" "${FIX}/${REG}/blobs/sha256:${digest}"
        layers="$(jq -c --arg t "${f}" --arg d "sha256:${digest}" '. + [{mediaType: "application/octet-stream", digest: $d, size: 1, annotations: {"org.opencontainers.image.title": $t}}]' <<<"${layers}")"
    done < <(cd "${tree}" && find . -type f -printf '%P\n' | LC_ALL=C sort)
    jq -n --argjson l "${layers}" --arg b "${BOARD}" --arg a "${ARCH}" --arg c "$(printf 'd%.0s' $(seq 40))" --arg i "${INPUTS}" --arg cert "$(sha "${SCRATCH}/cert.pem")" \
        '{schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: "application/vnd.mica.board.kernel", config: {mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2}, layers: $l, annotations: {"mica.source-repo": "mica-build", "mica.source-commit": $c, "org.opencontainers.image.revision": $c, "mica.board": $b, "mica.arch": $a, "mica.component": "kernel", "mica.inputs": $i, "mica.verity-cert-sha256": $cert}}' |
        jq "${filter}" >"${SCRATCH}/manifest.json"
    digest="$(sha "${SCRATCH}/manifest.json")"
    cp "${SCRATCH}/manifest.json" "${FIX}/${REG}/manifests/sha256:${digest}"
    printf '# mica-lock v1\nrelease\tmica-build\t%s\t%s\nboard\t%s\tkernel\t%s\tghcr.io/micaoss/mica-build:kernel.%s.%s@sha256:%s\n' \
        "${label}" "$(printf 'd%.0s' $(seq 40))" "${BOARD}" "${ARCH}" "${BOARD}" "${label#*.}" "${digest}" >"${RELEASES}/download/${label}/mica-build.lock"
    jq -n --arg t "${label}" '[{tag_name: $t, draft: false, assets: [{name: "mica-build.lock"}, {name: "SHA256SUMS"}]}]' >"${RELEASES}/releases.json"
}

local_build
if out="$(fetch 2>&1)" && [ "$(cat "${CLONE}/_out/boards/${BOARD}/kernel/config")" = "local config" ] && [ -f "${CLONE}/_out/boards/${BOARD}/board.env" ] \
    && [ -f "${CLONE}/_out/boards/${BOARD}/manifests/board.pkgs" ] && cmp -s "${CLONE}/_out/boards/${BOARD}/trust/verity-signer.cert.pem" "${SCRATCH}/cert.pem" \
    && (cd "${CLONE}" && bash tools/boards.sh bundle-is "${BOARD}" "_out/boards/${BOARD}" >/dev/null); then
    pass "--fetch assembles the board from the tree and a local kernel build, exactly its outputs.tsv"
else
    fail "--fetch over a local build: ${out}"
fi
rm -rf "${CLONE}/_out/${BOARD}" "${CLONE}/_out/boards"
mkdir -p "${RELEASES}"; echo '[]' >"${RELEASES}/releases.json"
fetch_refuses "no local build and no release" "run make ${BOARD}-kernel"
publish "${BOARD}.20260914-0001"
if out="$(fetch 2>&1)" && [ "$(cat "${CLONE}/_out/boards/${BOARD}/kernel/config")" = "published config" ] \
    && (cd "${CLONE}" && bash tools/boards.sh bundle-is "${BOARD}" "_out/boards/${BOARD}" >/dev/null); then
    pass "--fetch takes the kernel of the latest release that published it with these inputs, by digest"
else
    fail "--fetch over a published kernel: ${out}"
fi
rm -rf "${CLONE}/_out/boards"
publish "${BOARD}.20260914-0001" '.annotations["mica.inputs"] = ("2" * 64)'
fetch_refuses "a published kernel of other inputs" "run make ${BOARD}-kernel"
publish "${BOARD}.20260914-0001" '.annotations["mica.verity-cert-sha256"] = ("0" * 64)'
fetch_refuses "a published kernel built against another verity certificate" "verity trust certificate that is not"
publish "${BOARD}.20260914-0001" '.annotations["mica.component"] = "uboot"'
fetch_refuses "a component annotated as another component" "is not the kernel component of ${BOARD}"
publish "${BOARD}.20260914-0001" '.annotations["mica.source-repo"] = "mica-boards"'
fetch_refuses "a component of another repository" "is not the kernel component of ${BOARD}"
publish "${BOARD}.20260914-0001" '.layers[0].annotations["org.opencontainers.image.title"] = "../kernel/config"'
fetch_refuses "a layer titled outside the bundle" "a layer title is not a relative path"
publish "${BOARD}.20260914-0001" . 'printf "extra\n" >kernel/extra.bin'
fetch_refuses "a component file its outputs.tsv does not list" "kernel/extra.bin"
publish "${BOARD}.20260914-0001" . 'rm kernel/config'
fetch_refuses "a component without a file its outputs.tsv lists" "kernel/config"

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
