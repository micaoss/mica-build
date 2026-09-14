#!/usr/bin/env bash
# The product reader: WHAT one image is made of, read out of products/<name>/
# and validated against the fetched board bundle, printed as plain KEY=value
# for the composer, the assembler and the tests to consume. Nothing else
# re-derives a product's inputs.
#
#   bash tools/product.sh <name>            validate, print the resolved inputs
#   bash tools/product.sh --list            every product, one per line
#
#   reads   products/<name>/product.env, defaults.toml, provisioning.toml, meta/
#           _out/boards/<board>/board.env and manifests/ (make board-fetch)
#           rootfs/packages/{feature,radio}-*.pkgs (the feature names that exist)
#   prints  PRODUCT, BOARD, BOARD_DIR, MICA_ARCH, PROFILE, FEATURES, RADIOS,
#           COMPONENTS, IMAGE_KINDS, SIZE_BUDGET_MB, META_DIR, DEFAULTS, PROVISIONING
#
# Every refusal names what was wrong and what the legal values are.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
PRODUCTS="${MICA_PRODUCTS_DIR:-${REPO_ROOT}/products}"
BOARDS="${MICA_BOARDS_DIR:-${REPO_ROOT}/_out/boards}"
PACKAGES="${REPO_ROOT}/rootfs/packages"
HARDWARE_FEATURES="wifi bluetooth display status-led can usb-gadget audio containers"
SECRET_KEYS="psk password passwordHash pin key"

die() { echo "error: $*" >&2; exit 1; }
in_list() { local n="$1"; shift; local i; for i in "$@"; do [ "$i" != "$n" ] || return 0; done; return 1; }
products() { for d in "${PRODUCTS}"/*/; do [ -f "${d}product.env" ] && basename "${d}"; done; }
# plain_value <file> <key> [required]: the value of a KEY=value or KEY="value" line.
plain_value() {
    local line
    line="$(grep -E "^$2=" "$1" || true)"
    [ "$(printf '%s\n' "${line}" | grep -c .)" -le 1 ] || die "$1 declares $2 more than once"
    if [ -z "${line}" ]; then [ "${3:-}" != required ] || die "$1 declares no $2"; return 0; fi
    case "${line}" in *'$('* | *'`'* | *'${'*) die "$1: $2 carries a substitution; a product file is plain KEY=value" ;; esac
    line="${line#*=}"; line="${line#\"}"; printf '%s\n' "${line%\"}"
}

case "${1:-}" in
--list) products; exit 0 ;;
'' | --*) echo "usage: bash tools/product.sh <name> | --list" >&2; exit 1 ;;
esac
NAME="$1"
DIR="${PRODUCTS}/${NAME}"
[ -f "${DIR}/product.env" ] || die "products/${NAME}/product.env does not exist; the products are: $(products | tr '\n' ' ')"

# Every line is KEY=value or a comment, and every key is one this contract names.
while IFS= read -r line; do
    case "${line}" in '' | '#'*) continue ;; esac
    [[ "${line}" =~ ^[A-Z_]+= ]] || die "products/${NAME}/product.env: a line that is neither KEY=value nor a comment: ${line}"
    key="${line%%=*}"
    in_list "${key}" PRODUCT BOARD PROFILE FEATURES COMPONENTS IMAGE_KINDS SIZE_BUDGET_MB || die "products/${NAME}/product.env declares ${key}, which the product contract does not name (products/README.md)"
done <"${DIR}/product.env"

PRODUCT="$(plain_value "${DIR}/product.env" PRODUCT required)"
[ "${PRODUCT}" = "${NAME}" ] || die "products/${NAME}/product.env declares PRODUCT=${PRODUCT}; the directory name is the product"
BOARD="$(plain_value "${DIR}/product.env" BOARD required)"
[ -f "${REPO_ROOT}/deps/packages/mica-kernel-${BOARD}.json" ] || die "product ${NAME}: BOARD=${BOARD} is not a pinned board; the pinned boards are: $(bash "${HERE}/board-pool.sh" --list | tr '\n' ' ')"
BOARD_DIR="${BOARDS}/${BOARD}"
[ -f "${BOARD_DIR}/board.env" ] || die "product ${NAME}: the board ${BOARD} is not fetched (make board-fetch BOARD=${BOARD})"
MICA_ARCH="$(plain_value "${BOARD_DIR}/board.env" MICA_ARCH required)"
BOARD_FEATURES="$(plain_value "${BOARD_DIR}/board.env" BOARD_FEATURES required)"
BOARD_IMAGE_KINDS="$(plain_value "${BOARD_DIR}/board.env" IMAGE_KINDS required)"
BOARD_BUDGET="$(plain_value "${BOARD_DIR}/board.env" BOARD_SIZE_BUDGET_MB required)"

PROFILE="$(plain_value "${DIR}/product.env" PROFILE required)"
in_list "${PROFILE}" dev prod || die "product ${NAME}: PROFILE=${PROFILE}; it is dev or prod"

# The features that exist: the engine's feature-*.pkgs and radio-*.pkgs.
shopt -s nullglob
KNOWN=""; RADIOS_KNOWN=""
for f in "${PACKAGES}"/feature-*.pkgs; do b="$(basename "${f}" .pkgs)"; KNOWN="${KNOWN} ${b#feature-}"; done
for f in "${PACKAGES}"/radio-*.pkgs; do b="$(basename "${f}" .pkgs)"; KNOWN="${KNOWN} ${b#radio-}"; RADIOS_KNOWN="${RADIOS_KNOWN} ${b#radio-}"; done
shopt -u nullglob
FEATURES="$(plain_value "${DIR}/product.env" FEATURES required)"
RADIOS=""
for f in ${FEATURES}; do
    in_list "${f}" ${KNOWN} || die "product ${NAME}: FEATURES names '${f}', which no feature-*.pkgs or radio-*.pkgs under rootfs/packages defines; the features are:${KNOWN}"
    if in_list "${f}" ${HARDWARE_FEATURES}; then
        in_list "${f}" ${BOARD_FEATURES} || die "product ${NAME}: FEATURES names '${f}', which the board ${BOARD} does not have (BOARD_FEATURES=\"${BOARD_FEATURES}\")"
    fi
    ! in_list "${f}" ${RADIOS_KNOWN} || RADIOS="${RADIOS} ${f}"
done

COMPONENTS="$(plain_value "${DIR}/product.env" COMPONENTS || true)"
for c in ${COMPONENTS}; do
    [ -f "${BOARD_DIR}/manifests/component-${c}.pkgs" ] || die "product ${NAME}: COMPONENTS names '${c}', and the board ${BOARD} ships no manifests/component-${c}.pkgs"
done

IMAGE_KINDS="$(plain_value "${DIR}/product.env" IMAGE_KINDS required)"
[ -n "${IMAGE_KINDS}" ] || die "product ${NAME}: IMAGE_KINDS is empty; a product with no image kind produces nothing"
for k in ${IMAGE_KINDS}; do
    in_list "${k}" ${BOARD_IMAGE_KINDS} || die "product ${NAME}: IMAGE_KINDS names '${k}', which the board ${BOARD} does not produce (IMAGE_KINDS=\"${BOARD_IMAGE_KINDS}\")"
done

SIZE_BUDGET_MB="$(plain_value "${DIR}/product.env" SIZE_BUDGET_MB || true)"
if [ -n "${SIZE_BUDGET_MB}" ]; then
    [[ "${SIZE_BUDGET_MB}" =~ ^[0-9]+$ ]] || die "product ${NAME}: SIZE_BUDGET_MB=${SIZE_BUDGET_MB} is not a number"
    [ "${SIZE_BUDGET_MB}" -le "${BOARD_BUDGET}" ] || die "product ${NAME}: SIZE_BUDGET_MB=${SIZE_BUDGET_MB} exceeds the board's BOARD_SIZE_BUDGET_MB=${BOARD_BUDGET}; a product may only lower it"
else
    SIZE_BUDGET_MB="${BOARD_BUDGET}"
fi

META_DIR="${DIR}/meta"
[ -f "${META_DIR}/updates/manifest.json" ] || die "product ${NAME}: meta/updates/manifest.json is missing; the public factory manifest is a product's (meta.example/README.md)"

DEFAULTS=""
if [ -e "${DIR}/defaults.toml" ]; then
    DEFAULTS="${DIR}/defaults.toml"
    python3 - "${DEFAULTS}" ${SECRET_KEYS} <<'PY' || exit 1
import sys
try:
    import tomllib
except ImportError:
    import tomli as tomllib
path, secrets = sys.argv[1], set(sys.argv[2:])
try:
    doc = tomllib.load(open(path, 'rb'))
except tomllib.TOMLDecodeError as e:
    raise SystemExit(f'error: {path}: not valid TOML: {e}')
if doc.get('version') != 1:
    raise SystemExit(f'error: {path}: version = 1 is required (found {doc.get("version")!r})')
def walk(table, at):
    for k, v in table.items():
        if k in secrets:
            raise SystemExit(f'error: {path}: {".".join(at + [k])} is a secret-bearing key; a product default is never a secret, and a value like this travels in provisioning.toml')
        if isinstance(v, dict):
            walk(v, at + [k])
walk(doc, [])
PY
fi
PROVISIONING=""
if [ -e "${DIR}/provisioning.toml" ]; then
    PROVISIONING="${DIR}/provisioning.toml"
    python3 -c 'import sys
try:
    import tomllib
except ImportError:
    import tomli as tomllib
d = tomllib.load(open(sys.argv[1], "rb")); assert d.get("version") == 1, "version = 1 is required"' "${PROVISIONING}" 2>/dev/null || die "product ${NAME}: provisioning.toml is not a valid provisioning document (TOML with version = 1)"
fi

printf 'PRODUCT=%s\n' "${PRODUCT}"
printf 'BOARD=%s\n' "${BOARD}"
printf 'BOARD_DIR=%s\n' "${BOARD_DIR}"
printf 'MICA_ARCH=%s\n' "${MICA_ARCH}"
printf 'PROFILE=%s\n' "${PROFILE}"
printf 'FEATURES="%s"\n' "${FEATURES}"
printf 'RADIOS="%s"\n' "${RADIOS# }"
printf 'COMPONENTS="%s"\n' "${COMPONENTS}"
printf 'IMAGE_KINDS="%s"\n' "${IMAGE_KINDS}"
printf 'SIZE_BUDGET_MB=%s\n' "${SIZE_BUDGET_MB}"
printf 'META_DIR=%s\n' "${META_DIR}"
printf 'DEFAULTS=%s\n' "${DEFAULTS}"
printf 'PROVISIONING=%s\n' "${PROVISIONING}"
