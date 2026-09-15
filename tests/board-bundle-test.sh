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

# --fetch: the component artifacts the board rows of locks/ name, by digest, assembled into one bundle.
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

COMPONENTS="board firmware kernel uboot"
# component_of <path>: the component that carries a bundle path (mica:docs/boards/contract.md section 3).
component_of() {
    case "$1" in kernel/*) echo kernel ;; uboot/* | uboot-package/*) echo uboot ;; firmware.tar | firmware/* | component-copyright) echo firmware ;; *) echo board ;; esac
}
# board_lock <release> <registry name>: the lock and pin naming the fitboard components, whose digests are in ${SCRATCH}/digests.
board_lock() {
    mkdir -p "${SCRATCH}/locks/pins"
    { printf '# mica-lock v1\nrelease\tfixture-boards\t%s\t%s\n' "$1" "${COMMIT}"
      for c in ${COMPONENTS}; do
          d="$(sed -n "s/^${c} //p" "${SCRATCH}/digests")"
          [ -z "${d}" ] || printf 'board\tfitboard\t%s\tarm64\t%s:%s.fitboard.%s@sha256:%s\n' "${c}" "$2" "${c}" "$1" "${d}"
      done; } >"${SCRATCH}/locks/fixture-boards.lock"
    printf '# mica-pin v1\nREPOSITORY=fixture-boards\nRELEASE=%s\nSHA256SUMS=%s\n' "$1" "$(printf '0%.0s' $(seq 64))" >"${SCRATCH}/locks/pins/fixture-boards.pin"
}
# outputs <tree>: the tree's outputs.tsv, a file row per file at its assembled path (firmware.tar as its members) and no package.
outputs() {
    { printf '# mica-boards board outputs v1\n'
      { (cd "$1" && find . -type f ! -name firmware.tar -printf '%P\n'; [ ! -f firmware.tar ] || tar -tf firmware.tar | grep -v '/$'); echo outputs.tsv; } |
          LC_ALL=C sort -u | while IFS= read -r f; do printf 'file\t%s\t%s\n' "$(component_of "${f}")" "${f}"; done | LC_ALL=C sort; } >"${SCRATCH}/outputs.tsv"
    mv "${SCRATCH}/outputs.tsv" "$1/outputs.tsv"
}
# artifact [<component> <jq filter>] [tree edit]: publish the fitboard bundle as its component artifacts, and the lock naming them.
artifact() {
    local tree="${SCRATCH}/artifact" f digest c
    rm -rf "${FIX}" "${tree}" "${SCRATCH}/locks" "${SCRATCH}/cache" "${SCRATCH}/boards" "${SCRATCH}/manifests"
    mkdir -p "${FIX}/${REG}/blobs" "${FIX}/${REG}/manifests" "${SCRATCH}/manifests"
    printf '{"token":"fixture"}\n' >"${FIX}/token.json"
    cp -a "$(bundle fitboard uboot-fit kernel/dev kernel/prod)" "${tree}"
    mkdir -p "${tree}/firmware/vendor" "${tree}/uboot"; printf 'blob\n' >"${tree}/firmware/vendor/fw.bin"; printf 'loader\n' >"${tree}/uboot/u-boot.bin"
    (cd "${tree}" && tar -cf firmware.tar firmware && rm -rf firmware)
    outputs "${tree}"
    [ -z "${3:-}" ] || (cd "${tree}" && eval "$3")
    : >"${SCRATCH}/digests"
    for c in ${COMPONENTS}; do
        layers="[]"
        while IFS= read -r f; do
            [ "$(component_of "${f}")" = "${c}" ] || continue
            digest="$(sha "${tree}/${f}")"
            cp "${tree}/${f}" "${FIX}/${REG}/blobs/sha256:${digest}"
            layers="$(jq -c --arg t "${f}" --arg d "sha256:${digest}" '. + [{mediaType: "application/octet-stream", digest: $d, size: 1, annotations: {"org.opencontainers.image.title": $t}}]' <<<"${layers}")"
        done < <(cd "${tree}" && find . -type f -printf '%P\n' | LC_ALL=C sort)
        [ "${layers}" != "[]" ] || continue
        type="application/vnd.mica.board"; [ "${c}" = board ] || type="${type}.${c}"
        jq -n --argjson l "${layers}" --arg t "${type}" --arg comp "${c}" --arg c "${COMMIT}" --arg cert "$(sha "${SCRATCH}/cert.pem")" '{schemaVersion: 2, mediaType: "application/vnd.oci.image.manifest.v1+json", artifactType: $t, config: {mediaType: "application/vnd.oci.empty.v1+json", digest: "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", size: 2}, layers: $l, annotations: {"mica.source-repo": "fixture-boards", "mica.source-commit": $c, "org.opencontainers.image.revision": $c, "mica.board": "fitboard", "mica.arch": "arm64", "mica.component": $comp, "mica.inputs": ("1" * 64), "mica.verity-cert-sha256": $cert}}' |
            jq "$([ "${c}" = "${1:-}" ] && printf '%s' "$2" || printf '.')" >"${SCRATCH}/manifests/${c}.json"
        digest="$(sha "${SCRATCH}/manifests/${c}.json")"
        cp "${SCRATCH}/manifests/${c}.json" "${FIX}/${REG}/manifests/sha256:${digest}"
        printf '%s %s\n' "${c}" "${digest}" >>"${SCRATCH}/digests"
    done
    board_lock 20260914-0001 "ghcr.io/${REG}"
}
fetch() {
    PATH="${SHIM}:${PATH}" BUNDLE_TEST_REGISTRY="${FIX}" MICA_LOCKS_DIR="${SCRATCH}/locks" \
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
    && cmp -s "${SCRATCH}/boards/fitboard/kernel/prod/config" "${SCRATCH}/artifact/kernel/prod/config" && [ -f "${SCRATCH}/boards/fitboard/uboot/u-boot.bin" ]; then
    pass "--fetch assembles the four components at their paths and unpacks firmware.tar into firmware/"
else
    fail "--fetch of valid component artifacts: ${out}"
fi
artifact kernel '.annotations["mica.verity-cert-sha256"] = ("0" * 64)'
fetch_refuses "a component built against another verity certificate" "verity trust certificate that is not"
artifact firmware '.annotations["mica.source-commit"] = ("e" * 40)'
fetch_refuses "a component of another commit" "is not the firmware component of fitboard"
artifact uboot '.annotations["mica.component"] = "kernel"'
fetch_refuses "a component annotated as another component" "is not the uboot component of fitboard"
artifact kernel '.artifactType = "application/vnd.mica.board"'
fetch_refuses "a component of another artifact type" "is not the kernel component of fitboard"
artifact board '.layers[0].annotations["org.opencontainers.image.title"] = "../board.env"'
fetch_refuses "a layer titled outside the bundle" "a layer title is not a relative path"
artifact firmware '.layers += [.layers[0] | .annotations["org.opencontainers.image.title"] = "board.env"]'
fetch_refuses "a path carried by two components" "board.env of"
artifact
sed -i '/\tkernel\t/d' "${SCRATCH}/locks/fixture-boards.lock"
fetch_refuses "a board lock without its kernel component" "pins no kernel component of fitboard"
artifact
(cd "${SCRATCH}" && mkdir -p escape && printf 'x\n' >escape/x && tar -cf "${SCRATCH}/evil.tar" escape)
digest="$(sha "${SCRATCH}/evil.tar")"
artifact firmware "(.layers[] | select(.annotations[\"org.opencontainers.image.title\"] == \"firmware.tar\") | .digest) = \"sha256:${digest}\""
cp "${SCRATCH}/evil.tar" "${FIX}/${REG}/blobs/sha256:${digest}"
fetch_refuses "a firmware.tar member outside firmware/" "holds a member outside firmware/"
artifact . . 'printf "extra\n" >kernel/dev/extra.bin'
fetch_refuses "a component file its outputs.tsv does not list" "> kernel	kernel/dev/extra.bin"
artifact . . 'printf "file\tkernel\tkernel/dev/missing.bin\n" >>outputs.tsv'
fetch_refuses "a file row with no file" "< kernel	kernel/dev/missing.bin"
artifact . . 'sed -i "s|^file\tuboot\tuboot/u-boot.bin$|file\tfirmware\tuboot/u-boot.bin|" outputs.tsv'
fetch_refuses "a file row naming another component" "< firmware	uboot/u-boot.bin"
artifact . . 'printf "package\tmica-board-fitboard\n" >>outputs.tsv'
fetch_refuses "a package row the board's lock does not pin" "< mica-board-fitboard"
artifact . . 'rm outputs.tsv'
fetch_refuses "a bundle without outputs.tsv" "carries no outputs.tsv"

# --fetch over an offline lock (tools/local-pins.sh): the components out of the checkout's OCI layout, never in CI.
offline_fixture() {
    artifact
    local layout="${SCRATCH}/checkout/_out/offline/oci" c
    rm -rf "${SCRATCH}/checkout"; mkdir -p "${layout}/blobs"
    cp -r "${FIX}/${REG}/blobs" "${layout}/blobs/sha256"
    for f in "${layout}"/blobs/sha256/sha256:*; do mv "${f}" "${f%/*}/${f##*sha256:}"; done
    for c in ${COMPONENTS}; do cp "${SCRATCH}/manifests/${c}.json" "${layout}/blobs/sha256/$(sha "${SCRATCH}/manifests/${c}.json")"; done
    rm -rf "${FIX}"
    board_lock offline "local/fixture-boards"
    printf 'CHECKOUT=%s\n' "${SCRATCH}/checkout" >>"${SCRATCH}/locks/pins/fixture-boards.pin"
}
offline_fixture
if out="$(CI='' GITHUB_ACTIONS='' fetch 2>&1)" && cmp -s "${SCRATCH}/boards/fitboard/kernel/dev/config" "${SCRATCH}/artifact/kernel/dev/config"; then
    pass "--fetch over an offline lock reads the components out of the checkout's OCI layout"
else
    fail "--fetch over an offline lock: ${out}"
fi
offline_fixture
GITHUB_ACTIONS=true fetch_refuses "an offline pin under GitHub Actions" "refused checkout-in-ci"

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
