#!/usr/bin/env bash
# The mica-system-base release this repository composes on: system-base.lock.
#
#   bash tools/system-base.sh verify           the lock is its release's (downloads SHA256SUMS, no credential)
#   bash tools/system-base.sh check            the locks, the sources and the record are well formed, no network
#   bash tools/system-base.sh sources-uri      the one Debian archive later stages resolve from (system-base.sources)
#   bash tools/system-base.sh commit           the release commit, read from both pool manifests
#   bash tools/system-base.sh rows [--arch A]  the pool's archives as tools/pool.sh rows
#   bash tools/system-base.sh blob <arch> <sha256> <out>   one pool layer, verified by digest
#
# system-base.lock, system-base-packages.lock and system-base.sources are the
# assets of the mica-system-base release named in system-base-release, committed
# unchanged and replaced together (mica-system-base README, "Consuming a
# release"); they are the only places this repository names a Base artifact.
# system-base.sources is the only Debian archive anything here resolves from.
# system-base.lock names the rootfs index and its two platform manifests
# (IMAGE_MICA_SYSTEM_BASE_ROOTFS*, read by tools/from.sh) and the two pools
# (POOL_MICA_SYSTEM_BASE_<ARCH>). A pool manifest is read anonymously by its
# digest, must hash to it, and must be the application/vnd.mica.pool of
# mica-system-base for its architecture; a package is found by its layer title.
# Read manifests are kept under _out/cache/oci/<digest>.json and hashed again on
# every read.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
LOCK="${MICA_SYSTEM_BASE_LOCK:-${REPO_ROOT}/system-base.lock}"
RECORD="${MICA_SYSTEM_BASE_RECORD:-${REPO_ROOT}/system-base-release}"
CACHE="${MICA_OCI_CACHE:-${REPO_ROOT}/_out/cache/oci}"
URL_BASE="https://github.com/micaoss/mica-system-base/releases/download"
KEYS="IMAGE_MICA_SYSTEM_BASE_ROOTFS IMAGE_MICA_SYSTEM_BASE_ROOTFS_AMD64 IMAGE_MICA_SYSTEM_BASE_ROOTFS_ARM64 POOL_MICA_SYSTEM_BASE_AMD64 POOL_MICA_SYSTEM_BASE_ARM64"
REGISTRY=ghcr.io/micaoss/mica-system-base

die() { echo "system-base.sh: error: $*" >&2; exit 1; }

SOURCES="${MICA_SYSTEM_BASE_SOURCES:-${REPO_ROOT}/system-base.sources}"

# One deb822 stanza: the snapshot archive, trixie main, signed by the Debian archive keyring.
check_sources() {
    [ -f "${SOURCES}" ] || die "${SOURCES} does not exist; it is the system-base.sources asset of the Base release"
    local stanza
    stanza="$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "${SOURCES}" | LC_ALL=C sort | tr '\n' '|')"
    [[ "${stanza}" =~ ^Check-Valid-Until:\ no\|Components:\ main\|Signed-By:\ /usr/share/keyrings/debian-archive-keyring\.gpg\|Suites:\ trixie\|Types:\ deb\|URIs:\ https://snapshot\.debian\.org/archive/debian/[0-9]{8}T[0-9]{6}Z\|$ ]] ||
        die "${SOURCES} is not one deb822 stanza of the Debian snapshot archive, trixie main, signed by the Debian archive keyring"
}

check_record() {
    [ -f "${RECORD}" ] || die "${RECORD} does not exist; it records the release system-base.lock came from"
    local keys
    keys="$(sed -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' -e 's/=.*//' "${RECORD}" | LC_ALL=C sort | tr '\n' ' ')"
    [ "${keys}" = "SYSTEM_BASE_RELEASE SYSTEM_BASE_SHA256SUMS " ] ||
        die "${RECORD} must hold exactly SYSTEM_BASE_RELEASE and SYSTEM_BASE_SHA256SUMS, once each; it holds: ${keys:-nothing}"
    RELEASE="$(sed -n 's/^SYSTEM_BASE_RELEASE=//p' "${RECORD}")"
    TRUST="$(sed -n 's/^SYSTEM_BASE_SHA256SUMS=//p' "${RECORD}")"
    [[ "${RELEASE}" =~ ^[0-9]{8}-[0-9]{4}$ ]] || die "SYSTEM_BASE_RELEASE='${RELEASE}' is not a release tag YYYYMMDD-HHMM"
    [[ "${TRUST}" =~ ^[0-9a-f]{64}$ ]] || die "SYSTEM_BASE_SHA256SUMS='${TRUST}' is not 64 lowercase hex"
}

declare -A VALUE=()
check_lock() {
    [ -f "${LOCK}" ] || die "${LOCK} does not exist; it is the system-base.lock asset of a mica-system-base release"
    local line key value pattern
    while IFS= read -r line || [ -n "${line}" ]; do
        case "${line}" in '' | '#'*) continue ;; esac
        [[ "${line}" =~ ^([A-Z][A-Z0-9_]*)=([^[:space:]]+)$ ]] || die "${LOCK} holds a line that is not KEY=<reference>: ${line}"
        key="${BASH_REMATCH[1]}"
        value="${BASH_REMATCH[2]}"
        case " ${KEYS} " in *" ${key} "*) ;; *) die "${LOCK} defines ${key}, which a system-base.lock does not name" ;; esac
        [ -z "${VALUE[${key}]:-}" ] || die "${LOCK} gives ${key} more than once"
        case "${key}" in
        IMAGE_MICA_SYSTEM_BASE_ROOTFS) pattern="^${REGISTRY//./\\.}:rootfs\.[0-9]{8}-[0-9]{4}@sha256:[0-9a-f]{64}$" ;;
        IMAGE_MICA_SYSTEM_BASE_ROOTFS_*) pattern="^${REGISTRY//./\\.}@sha256:[0-9a-f]{64}$" ;;
        POOL_MICA_SYSTEM_BASE_AMD64) pattern="^${REGISTRY//./\\.}:pool\.amd64\.[0-9]{8}-[0-9]{4}@sha256:[0-9a-f]{64}$" ;;
        POOL_MICA_SYSTEM_BASE_ARM64) pattern="^${REGISTRY//./\\.}:pool\.arm64\.[0-9]{8}-[0-9]{4}@sha256:[0-9a-f]{64}$" ;;
        esac
        [[ "${value}" =~ ${pattern} ]] || die "${key}=${value} is not a ${REGISTRY} reference of its kind by digest"
        VALUE["${key}"]="${value}"
    done <"${LOCK}"
    for key in ${KEYS}; do
        [ -n "${VALUE[${key}]:-}" ] || die "${LOCK} gives no ${key}"
    done
}

# Anonymous registry reads: a pull token, then the path.
TOKEN=""
oci_get() { # <path> <out> <accept>
    local code
    if [ -z "${TOKEN}" ]; then
        code="$(curl -sS -o "${WORK}/token.json" -w '%{http_code}' --max-time 60 "https://ghcr.io/token?scope=repository:${REGISTRY#ghcr.io/}:pull&service=ghcr.io" || echo 000)"
        [ "${code}" = 200 ] || die "the token endpoint of ghcr.io answered ${code} for ${REGISTRY#ghcr.io/} (000: not reached)"
        TOKEN="$(jq -r '.token // .access_token // empty' "${WORK}/token.json")"
        [ -n "${TOKEN}" ] || die "ghcr.io issued no pull token for ${REGISTRY#ghcr.io/}"
    fi
    code="$(curl -sS -L -o "$2" -w '%{http_code}' --max-time 1800 -H "Authorization: Bearer ${TOKEN}" -H "Accept: $3" "https://ghcr.io/v2/${REGISTRY#ghcr.io/}/$1" || echo 000)"
    [ "${code}" = 200 ] || die "reading ${REGISTRY} $1 answered ${code} (000: not reached)"
}

# The verified pool manifest of one architecture; prints its path.
manifest() { # <arch>
    local arch="$1" key ref digest out
    case "${arch}" in amd64 | arm64) ;; *) die "the architecture must be amd64 or arm64" ;; esac
    key="POOL_MICA_SYSTEM_BASE_${arch^^}"
    ref="${VALUE[${key}]}"
    digest="${ref#*@}"
    out="${CACHE}/${digest}.json"
    if [ ! -f "${out}" ] || [ "sha256:$(sha256sum "${out}" | cut -d' ' -f1)" != "${digest}" ]; then
        mkdir -p "${CACHE}"
        oci_get "manifests/${digest}" "${out}.part" application/vnd.oci.image.manifest.v1+json
        [ "sha256:$(sha256sum "${out}.part" | cut -d' ' -f1)" = "${digest}" ] || { rm -f "${out}.part"; die "${REGISTRY} served a manifest for ${digest} with other bytes"; }
        mv "${out}.part" "${out}"
    fi
    jq -e --arg a "${arch}" '.artifactType == "application/vnd.mica.pool" and .annotations["mica.source-repo"] == "mica-system-base"
        and (.annotations["mica.source-commit"] | test("^[0-9a-f]{40}$")) and .annotations["org.opencontainers.image.revision"] == .annotations["mica.source-commit"]
        and .annotations["mica.arch"] == $a' "${out}" >/dev/null ||
        die "${ref} is not the ${arch} pool of mica-system-base"
    printf '%s\n' "${out}"
}

commit() {
    local amd64 arm64
    amd64="$(jq -r '.annotations["mica.source-commit"]' "$(manifest amd64)")"
    arm64="$(jq -r '.annotations["mica.source-commit"]' "$(manifest arm64)")"
    [ "${amd64}" = "${arm64}" ] || die "the amd64 pool names commit ${amd64} and the arm64 pool ${arm64}; one release has one commit"
    printf '%s\n' "${amd64}"
}

rows() { # [arch]
    local arch c
    c="$(commit)"
    for arch in amd64 arm64; do
        [ -z "${1:-}" ] || [ "$1" = "${arch}" ] || continue
        jq -r --arg c "${c}" --arg a "${arch}" '.layers[] | select(.mediaType == "application/vnd.mica.deb")
            | .annotations["org.opencontainers.image.title"] as $t
            | ([$t | capture("^(?<n>[a-z0-9][a-z0-9+.-]+)_(?<v>[0-9]{8}-[0-9]{4}-[1-9][0-9]*)_(?<arch>[a-z0-9]+)\\.deb$")] | if length == 1 then .[0] else error("layer \($t) is not an archive name") end) as $f
            | if ($f.arch == $a or $f.arch == "all") then [$f.n, $f.v, $f.arch, (.digest | ltrimstr("sha256:")), "mica-system-base", $c, $t] | @tsv else error("layer \($t) is not an archive of this pool") end' \
            "$(manifest "${arch}")" || die "the ${arch} pool of mica-system-base carries a layer whose title is not <package>_<release>-<n>_<arch>.deb"
    done
}

cmd="${1:-}"
[ "$#" -eq 0 ] || shift
case "${cmd}" in
check)
    [ "$#" -eq 0 ] || die "check takes no argument"
    check_record
    check_lock
    check_sources
    rel="${VALUE[IMAGE_MICA_SYSTEM_BASE_ROOTFS]#*:rootfs.}"
    [ "${rel%@*}" = "${RELEASE}" ] || die "${LOCK} is the lock of ${rel%@*}, and ${RECORD} records ${RELEASE}"
    echo "system-base.sh: system-base.lock, system-base.sources and system-base-release are well formed (release ${RELEASE})"
    ;;
verify)
    [ "$#" -eq 0 ] || die "verify takes no argument"
    check_record
    check_lock
    work="$(mktemp -d)"
    trap 'rm -rf "${work}"' EXIT
    curl -fsSL --retry 3 --max-time 120 -o "${work}/SHA256SUMS" "${URL_BASE}/${RELEASE}/SHA256SUMS" ||
        die "downloading ${URL_BASE}/${RELEASE}/SHA256SUMS failed"
    got="$(sha256sum "${work}/SHA256SUMS" | cut -d' ' -f1)"
    [ "${got}" = "${TRUST}" ] || die "SHA256SUMS of ${RELEASE} hashes to ${got}, and ${RECORD} records ${TRUST}"
    [ "$(LC_ALL=C sed 's/^[0-9a-f]\{64\}  //' "${work}/SHA256SUMS" | LC_ALL=C sort | tr '\n' ' ')" = "system-base-packages.lock system-base.lock system-base.sources " ] ||
        die "SHA256SUMS of ${RELEASE} does not list exactly system-base.lock, system-base-packages.lock and system-base.sources"
    (cd "${REPO_ROOT}" && sha256sum --quiet -c "${work}/SHA256SUMS") ||
        die "the committed Base assets are not the ones SHA256SUMS of ${RELEASE} names; they are committed unchanged"
    check_sources
    echo "system-base.sh: system-base.lock, system-base-packages.lock and system-base.sources are the assets of mica-system-base ${RELEASE} (SHA256SUMS ${TRUST:0:12}), verified"
    ;;
sources-uri)
    [ "$#" -eq 0 ] || die "sources-uri takes no argument"
    check_sources
    sed -n 's/^URIs: //p' "${SOURCES}"
    ;;
commit | rows | blob)
    for t in curl jq sha256sum; do
        command -v "${t}" >/dev/null 2>&1 || die "${t} is required and not on PATH"
    done
    check_lock
    mkdir -p "${REPO_ROOT}/_out"
    WORK="$(mktemp -d "${REPO_ROOT}/_out/.system-base.XXXXXX")"
    trap 'rm -rf "${WORK}"' EXIT
    case "${cmd}" in
    commit)
        [ "$#" -eq 0 ] || die "commit takes no argument"
        commit
        ;;
    rows)
        arch=""
        if [ "$#" -gt 0 ]; then
            [ "$#" -eq 2 ] && [ "$1" = --arch ] || die "usage: rows [--arch amd64|arm64]"
            arch="$2"
            case "${arch}" in amd64 | arm64) ;; *) die "--arch must be amd64 or arm64" ;; esac
        fi
        rows "${arch}"
        ;;
    blob)
        [ "$#" -eq 3 ] && [[ "$2" =~ ^[0-9a-f]{64}$ ]] || die "usage: blob <arch> <sha256> <out>"
        layer="$(jq -r --arg d "sha256:$2" '[.layers[] | select(.digest == $d and .mediaType == "application/vnd.mica.deb")] | length' "$(manifest "$1")")"
        [ "${layer}" = 1 ] || die "the $1 pool of mica-system-base carries no archive layer sha256:$2"
        oci_get "blobs/sha256:$2" "$3" application/octet-stream
        ;;
    esac
    ;;
*)
    die "usage: bash tools/system-base.sh verify | check | sources-uri | commit | rows [--arch A] | blob <arch> <sha256> <out>"
    ;;
esac
