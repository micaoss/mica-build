#!/usr/bin/env bash
# The inputs hash of a producer at one architecture: sha256 over a sorted
# manifest of everything in this repository that determines its archives'
# bytes. It is a guard, not a reuse key: a pool layer records it as
# mica.inputs (tools/deb/publish.sh), and tools/deb/version-guard.sh refuses an
# archive whose version is published with other inputs -- a change that forgot
# its version bump (mica:docs/decisions/2026-09-15-package-versions.md R4).
#
#   bash tools/deb/package-inputs.sh <producer> <amd64|arm64|all>             the hash
#   bash tools/deb/package-inputs.sh --manifest <producer> <amd64|arm64|all>  the manifest it is taken over
#
# The manifest, as `<kind> <name> <value>` lines:
#   producer  the producer's name without its instance
#   arch      the architecture it is built at
#   version   the declared VERSION and SOURCE_DATE_EPOCH (version.env)
#   file      the producer directory's tracked files, the FOR_EACH instance file, the control templates
#             and version.env, the packaging tooling that shapes the bytes (tools/deb/build.sh, pack.sh,
#             producers.sh), the paths its Dockerfile COPYs from each BUILD_CONTEXTS entry, and the
#             paths a PREPARE hook declares in PREPARE_INPUTS
#   image     an upstream image a PREPARE hook declares (PREPARE_INPUTS image:<name>) or FROM_IMAGES
#             names, by its reference in locks/mica-build-env.lock
# Build-env image digests are not inputs: a toolchain move that changes bytes is
# caught where an unchanged version must rebuild byte-identically.
set -euo pipefail
export LC_ALL=C

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/../.." && pwd)"
die() { echo "package-inputs.sh: error: $*" >&2; exit 1; }

MODE=hash
[ "${1-}" != --manifest ] || { MODE=manifest; shift; }
[ "$#" -eq 2 ] || die "usage: bash tools/deb/package-inputs.sh [--manifest] <producer> <amd64|arm64|all>"
PRODUCER="$1" ARCH="$2"
case "${ARCH}" in amd64 | arm64 | all) ;; *) die "'${ARCH}' is not amd64, arm64 or all" ;; esac
cd "${REPO_ROOT}"
DIR="$(bash tools/deb/producers.sh --dir-for "${PRODUCER}")" || die "no producer ${PRODUCER}"
INSTANCE="$(bash tools/deb/producers.sh --instance-for "${PRODUCER}")"
CONTROL="$(bash tools/deb/producers.sh --control-for "${PRODUCER}")"
DECLARED="$(bash tools/deb/producers.sh --version-for "${PRODUCER}")" || exit 1
vals="$(
    BUILD_CONTEXTS="" FROM_IMAGES="" PREPARE="" PREPARE_INPUTS=""
    # shellcheck disable=SC1090
    [ -z "${INSTANCE}" ] || . "./${INSTANCE}"
    # shellcheck disable=SC1090
    . "./${DIR}/producer.env"
    printf 'C=%s\nF=%s\nP=%s\nI=%s\n' "${BUILD_CONTEXTS}" "${FROM_IMAGES}" "${PREPARE}" "${PREPARE_INPUTS}"
)"
CONTEXTS="$(sed -n 's/^C=//p' <<<"${vals}")"
FROM_IMAGES="$(sed -n 's/^F=//p' <<<"${vals}")"
PREPARE="$(sed -n 's/^P=//p' <<<"${vals}")"
PREPARE_INPUTS="$(sed -n 's/^I=//p' <<<"${vals}")"
[ -z "${PREPARE}" ] || [ -n "${PREPARE_INPUTS}" ] ||
    die "${DIR}/producer.env names PREPARE=${PREPARE} and no PREPARE_INPUTS: the paths and image:<name> upstream images the hook builds from"

files() { # <path>...: tracked files and their sha256; a symlink by its target
    local listed
    listed="$(git ls-files -- "$@")"
    [ -n "${listed}" ] || die "no tracked file under $*"
    while IFS= read -r f; do
        if [ -L "${f}" ]; then printf 'link %s %s\n' "${f}" "$(readlink "${f}")"; else printf 'file %s %s\n' "${f}" "$(sha256sum "${f}" | cut -d' ' -f1)"; fi
    done <<<"${listed}"
}
# The sources a Dockerfile COPYs from the named context <name>: `COPY --from=<name> <src>... <dest>`.
copied_from() { # <dockerfile> <name>
    awk -v n="$2" '
        { line = line $0; if (sub(/\\$/, "", line)) next }
        { split(line, w, /[ \t]+/); line = "" }
        toupper(w[1]) == "COPY" {
            from = ""; first = 0
            for (i = 2; i <= length(w); i++) { if (w[i] ~ /^--from=/) { from = substr(w[i], 8) } else if (w[i] !~ /^--/) { first = i; break } }
            if (from == n && first) for (i = first; i < length(w); i++) print w[i]
        }' "$1"
}

{
    printf 'producer %s\n' "${PRODUCER%@*}"
    printf 'arch %s\n' "${ARCH}"
    printf 'version %s\n' "${DECLARED}"
    files "${DIR}" "${CONTROL}" "$(dirname "${CONTROL}")/version.env" tools/deb/build.sh tools/deb/pack.sh tools/deb/producers.sh
    [ -z "${INSTANCE}" ] || files "${INSTANCE}"
    for entry in ${CONTEXTS}; do
        name="${entry%%=*}" path="${entry#*=}"
        mapfile -t srcs < <(copied_from "${DIR}/Dockerfile" "${name}")
        [ "${#srcs[@]}" -gt 0 ] || continue
        files "${srcs[@]/#/${path}/}"
    done
    for entry in ${PREPARE_INPUTS}; do
        case "${entry}" in
        image:*) printf 'image %s %s\n' "${entry#image:}" "$(bash tools/from.sh --upstream "${entry#image:}")" ;;
        *) files "${entry}" ;;
        esac
    done
    for entry in ${FROM_IMAGES}; do
        case "${entry#*=}" in
        upstream:*) printf 'image %s %s\n' "${entry#*=upstream:}" "$(bash tools/from.sh --upstream "${entry#*=upstream:}")" ;;
        esac
    done
} | sort -u >"${TMPDIR:-/tmp}/package-inputs.$$"
trap 'rm -f "${TMPDIR:-/tmp}/package-inputs.$$"' EXIT
if [ "${MODE}" = manifest ]; then cat "${TMPDIR:-/tmp}/package-inputs.$$"; else sha256sum <"${TMPDIR:-/tmp}/package-inputs.$$" | cut -d' ' -f1; fi
