#!/usr/bin/env bash
# No board name in the engine. A board is data under boards/<board>/; the
# assembly dispatches on its facts (build/src/board-facts.ts: the boot
# backend, the firmware format, the FIT load map, the architecture) and never
# on its name. The names are read from boards/boards.tsv, so a board added
# tomorrow is covered the day it is listed.
#
#   bash tests/board-name-lint.sh          lint the tree
#   bash tests/board-name-lint.sh --test   prove the lint goes red on a planted literal
#
# Scope: Makefile, build/src, verify/src, rootfs/, tools/, tests/, common/,
# producers/ and .github/. Not *.test.ts (fixtures name boards on purpose), not products/ (a product names its
# board), not boards/ (a board directory is its own) and not locks/. A
# comment line, and a Makefile help line (`@echo "  ...`), may name a board:
# prose is not dispatch. A product's name (products/<name>) carries its
# board's and is not a board name: those are masked before the match.
# tests/board-name-lint.allow lists the files that name a board on purpose,
# one repository-relative path per line with the reason after `#`: a lab of
# one board's firmware, a fixture that enumerates the QEMU boards.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(pwd)"
ALLOW="${REPO_ROOT}/tests/board-name-lint.allow"

lint() { # <root>: prints every finding, returns 1 when there is one
    local root="$1" names pattern findings=0 f
    names="$(grep -v '^#' "${root}/boards/boards.tsv" | cut -f1 | sort -u)" || return 2
    [ -n "${names}" ] || { echo "error: ${root}/locks has no board row, so the lint has no name to look for" >&2; return 2; }
    pattern="\\b($(printf '%s\n' ${names} | paste -sd'|'))\\b"
    # A product's name is masked before the match: uefi-x64-dev is a product.
    local products="" mask="cat"
    products="$(for p in "${root}"/products/*/product.env; do [ -e "${p}" ] || continue; basename "$(dirname "${p}")"; done | sort -u | paste -sd'|')"
    [ -z "${products}" ] || mask="sed -E s/\\b(${products})\\b/PRODUCT/g"
    local allowed=""
    [ ! -f "${ALLOW}" ] || allowed="$(sed -E 's/[[:space:]]*#.*$//' "${ALLOW}" | grep -vE '^[[:space:]]*$' | tr '\n' ' ' || true)"
    while IFS= read -r f; do
        rel="${f#"${root}"/}"
        case " ${allowed} " in *" ${rel} "*) continue ;; esac
        # Comment lines and Makefile help lines are prose.
        hits="$(${mask} <"${f}" | grep -nE "${pattern}" | grep -vE '^[0-9]+:\s*(#|//|\*|/\*)' | grep -vE '^[0-9]+:\s*@echo "  ' || true)"
        [ -z "${hits}" ] || { printf '%s\n' "${hits}" | sed "s|^|${rel}:|"; findings=$((findings + 1)); }
    done < <({ printf '%s\n' "${root}/Makefile"; find "${root}/build/src" "${root}/verify/src" "${root}/rootfs" "${root}/tools" "${root}/tests" "${root}/.github" -type f \( -name '*.ts' -o -name '*.sh' -o -name '*.py' -o -name '*.yml' -o -name 'Dockerfile' -o -name '*.Dockerfile' \) \
        -not -path '*/node_modules/*' -not -name '*.test.ts' 2>/dev/null; } | sort)
    [ "${findings}" -eq 0 ]
}

case "${1:-}" in
--test)
    mkdir -p "${REPO_ROOT}/tmp"
    work="$(mktemp -d "${REPO_ROOT}/tmp/board-name-lint.XXXXXX")"
    trap 'rm -rf "${work}"' EXIT
    mkdir -p "${work}/build/src" "${work}/verify/src" "${work}/rootfs" "${work}/tools"
    cp -r "${REPO_ROOT}/locks" "${work}/locks"
    mkdir -p "${work}/boards"
    cp "${REPO_ROOT}/boards/boards.tsv" "${work}/boards/boards.tsv"
    cp "${REPO_ROOT}/Makefile" "${work}/Makefile"
    first="$(bash tools/boards.sh list | sed -n '1p')"
    # A clean copy passes...
    printf 'export const x = 1\n' >"${work}/build/src/clean.ts"
    if ALLOW=/dev/null lint "${work}" >/dev/null; then echo "PASS: a tree with no board name is clean"; else echo "FAIL: a clean tree was reported" >&2; exit 1; fi
    # ...a planted literal is red, naming the file and the line...
    printf "export const board = '%s'\n" "${first}" >"${work}/build/src/planted.ts"
    if out="$(ALLOW=/dev/null lint "${work}")"; then echo "FAIL: a planted '${first}' in build/src/planted.ts was not reported" >&2; exit 1; fi
    case "${out}" in *"build/src/planted.ts:1:"*) echo "PASS: the planted literal is reported at build/src/planted.ts:1" ;; *) echo "FAIL: the report does not name build/src/planted.ts:1: ${out}" >&2; exit 1 ;; esac
    # ...a comment is not dispatch...
    printf "// the %s board\nexport const y = 2\n" "${first}" >"${work}/build/src/planted.ts"
    if ALLOW=/dev/null lint "${work}" >/dev/null; then echo "PASS: a board name in a comment is prose"; else echo "FAIL: a comment was reported" >&2; exit 1; fi
    # ...and a product's name, which carries its board's, is a product.
    mkdir -p "${work}/products/${first}-dev" "${work}/tests"
    printf 'PRODUCT=%s-dev\n' "${first}" >"${work}/products/${first}-dev/product.env"
    printf 'MICA_PRODUCT=%s-dev bash rootfs/build.sh\n' "${first}" >"${work}/tests/product.sh"
    if ALLOW=/dev/null lint "${work}" >/dev/null; then echo "PASS: a product name is not a board name"; else echo "FAIL: a product name was reported: $(ALLOW=/dev/null lint "${work}" || true)" >&2; exit 1; fi
    echo "RESULT: PASS (4/4)"
    ;;
'')
    if out="$(lint "${REPO_ROOT}")"; then
        echo "RESULT: PASS (no board name in the engine; boards: $(bash tools/boards.sh list | tr '\n' ' '))"
    else
        printf '%s\n' "${out}"
        echo "RESULT: FAIL ($(printf '%s\n' "${out}" | wc -l) line(s) dispatch on a board name; see tests/board-name-lint.sh)"
        exit 1
    fi
    ;;
*) echo "usage: bash tests/board-name-lint.sh [--test]" >&2; exit 1 ;;
esac
