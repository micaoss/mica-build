#!/usr/bin/env bash
# tools/product.sh, driven over the tracked products and over perturbed
# copies of them: every product validates against its fetched board, and
# each refusal of the product contract (products/README.md) fires by name.
#
#   bash tests/product-test.sh          (make os-product-test; needs make board-fetch-all)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
SCRATCH="${REPO_ROOT}/tmp/product-test.$$"
mkdir -p "${SCRATCH}"
trap 'rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }

# 1. Every tracked product validates, and names its board's architecture.
n=0
for p in $(bash tools/product.sh --list); do
    n=$((n + 1))
    if out="$(bash tools/product.sh "${p}" 2>"${SCRATCH}/err")"; then
        arch="$(printf '%s\n' "${out}" | sed -n 's/^MICA_ARCH=//p')"
        board="$(printf '%s\n' "${out}" | sed -n 's/^BOARD=//p')"
        [ -n "${arch}" ] && [ -n "${board}" ] && pass "${p}: validates (board ${board}, ${arch})" || fail "${p}: printed no BOARD or MICA_ARCH"
    else
        fail "${p}: refused: $(cat "${SCRATCH}/err")"
    fi
done
[ "${n}" -gt 0 ] || { echo "error: tools/product.sh --list named no product; the loop above checked nothing" >&2; exit 1; }
for b in $(bash tools/board-pool.sh --list); do
    [ -f "products/${b}-minimal/product.env" ] && pass "board ${b} has its minimal product" || fail "board ${b} has no products/${b}-minimal"
done

# 2. The refusals, each on a perturbed copy of products/ (MICA_PRODUCTS_DIR)
#    or of a board (MICA_BOARDS_DIR), each naming its fault.
refuse() { # label fragment product [env...]
    local label="$1" fragment="$2" product="$3"; shift 3
    local err
    if err="$(env "$@" bash tools/product.sh "${product}" 2>&1 >/dev/null)"; then
        fail "${label}: validated where it had to refuse"
    elif [ "${err}" != "${err/${fragment}/}" ]; then
        pass "${label}: refused, naming '${fragment}'"
    else
        fail "${label}: refused, but without '${fragment}': ${err}"
    fi
}
mutate() { # name -> a copy of products/ under scratch, path printed
    local dir="${SCRATCH}/$1"; rm -rf "${dir}"; cp -a products "${dir}"; printf '%s' "${dir}"
}
set_key() { # dir product key value
    sed -i "/^$3=/d" "$1/$2/product.env"; printf '%s=%s\n' "$3" "$4" >>"$1/$2/product.env"
}

d="$(mutate unknown-key)"; printf 'COLOUR=blue\n' >>"${d}/x64-dev/product.env"
refuse "an unknown key" "does not name" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate wrong-name)"; set_key "${d}" x64-dev PRODUCT other
refuse "PRODUCT differs from the directory name" "directory name is the product" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate unknown-board)"; set_key "${d}" x64-dev BOARD nosuch
refuse "an unpinned board" "not a pinned board" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate bad-profile)"; set_key "${d}" x64-dev PROFILE staging
refuse "a profile that is neither dev nor prod" "dev or prod" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate unknown-feature)"; set_key "${d}" x64-dev FEATURES '"micad zigbee"'
refuse "a feature no manifest defines" "no feature-*.pkgs" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate radio-off-board)"; set_key "${d}" x64-dev FEATURES '"micad wifi"'
refuse "a radio the board does not have" "does not have" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate unknown-component)"; set_key "${d}" s905x5m-dev COMPONENTS '"hologram"'
refuse "a component the board does not ship" "ships no manifests/component-hologram.pkgs" s905x5m-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate unknown-kind)"; set_key "${d}" x64-dev IMAGE_KINDS '"disk floppy"'
refuse "an image kind the board does not produce" "does not produce" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate over-budget)"; set_key "${d}" x64-dev SIZE_BUDGET_MB 9999
refuse "a budget above the board's" "may only lower it" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate no-meta)"; rm -f "${d}/x64-dev/meta/updates/manifest.json"
refuse "a product with no public manifest" "meta/updates/manifest.json is missing" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate secret-default)"; printf 'version = 1\n[access.device]\npassword = "hunter2"\n' >"${d}/x64-dev/defaults.toml"
refuse "a secret in defaults.toml" "secret-bearing key" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate bad-defaults)"; printf 'version = 2\n' >"${d}/x64-dev/defaults.toml"
refuse "defaults.toml without version = 1" "version = 1 is required" x64-dev MICA_PRODUCTS_DIR="${d}"
d="$(mutate bad-provisioning)"; printf 'not toml [\n' >"${d}/x64-dev/provisioning.toml"
refuse "an invalid provisioning.toml" "not a valid provisioning document" x64-dev MICA_PRODUCTS_DIR="${d}"
# A board without room for the engine refuses a product that wants it.
bdir="${SCRATCH}/boards"; rm -rf "${bdir}"; cp -a _out/boards "${bdir}"
sed -i 's/^BOARD_FEATURES=.*/BOARD_FEATURES=""/' "${bdir}/x64/board.env"
refuse "containers on a board without room for the engine" "does not have" x64-dev MICA_BOARDS_DIR="${bdir}"
# ...and the positive controls: a valid defaults.toml and provisioning.toml pass and are reported.
d="$(mutate good-optional)"
printf 'version = 1\n[access.ssh]\nenabled = true\n' >"${d}/x64-dev/defaults.toml"
printf 'version = 1\n[admin]\npassword = "factory"\n' >"${d}/x64-dev/provisioning.toml"
if out="$(MICA_PRODUCTS_DIR="${d}" bash tools/product.sh x64-dev)"; then
    printf '%s\n' "${out}" | grep -c '^DEFAULTS=.*/defaults.toml$' >/dev/null && printf '%s\n' "${out}" | grep -c '^PROVISIONING=.*/provisioning.toml$' >/dev/null \
        && pass "a valid defaults.toml and provisioning.toml are accepted and reported" \
        || fail "the optional files were accepted but not reported: ${out}"
else
    fail "a valid defaults.toml and provisioning.toml were refused"
fi

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N} passed, ${FAIL_N} failed)"
[ "${FAIL_N}" -eq 0 ]
