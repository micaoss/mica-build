#!/usr/bin/env bash
# tools/offline-chain.sh over a fixture workspace: four small checkouts whose
# `make offline` only records when it ran and writes a pool listing. It proves
# the clones, the order, the refusals and the summary without building anything.
#
#   bash tests/offline-chain-test.sh      (make os-offline-chain-test; git and make, no docker, no network)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"
mkdir -p "${REPO_ROOT}/tmp"
SCRATCH="$(mktemp -d "${REPO_ROOT}/tmp/offline-chain-test.XXXXXX")"
trap 'rm -rf "${SCRATCH}"' EXIT
PASS_N=0
FAIL_N=0
pass() { PASS_N=$((PASS_N + 1)); echo "PASS: $1"; }
fail() { FAIL_N=$((FAIL_N + 1)); echo "FAIL: $1"; }
unset GITHUB_ACTIONS

WS="${SCRATCH}/workspace"
export OFFLINE_CHAIN_TEST_LOG="${SCRATCH}/events.log"
gitc() { git -c user.name=fixture -c user.email=fixture@example.invalid "$@"; }
checkout() { # <repository> [failing]
    local dir="${WS}/$1"
    mkdir -p "${dir}"
    if [ -n "${2:-}" ]; then
        printf 'offline:\n\t@echo "start $(notdir $(CURDIR))" >>"$$OFFLINE_CHAIN_TEST_LOG"\n\t@echo "the fixture build fails" >&2; exit 1\n' >"${dir}/Makefile"
    else
        printf 'offline:\n\t@echo "start $(notdir $(CURDIR)) verity=$$VERITY_TRUST_CERT" >>"$$OFFLINE_CHAIN_TEST_LOG"\n\t@sleep 1\n\t@mkdir -p _out/debs/amd64\n\t@printf "%%s  pool/fixture.deb\\n" "$$(printf %%064d 0)" >_out/debs/amd64/SHA256SUMS\n\t@echo "end $(notdir $(CURDIR))" >>"$$OFFLINE_CHAIN_TEST_LOG"\n' >"${dir}/Makefile"
    fi
    printf '_out/\nmeta/\n' >"${dir}/.gitignore"
    git init --quiet "${dir}"
    gitc -C "${dir}" add . && gitc -C "${dir}" commit --quiet -m fixture
}
workspace() { # [failing repository]
    rm -rf "${WS}" "${OFFLINE_CHAIN_TEST_LOG}"
    for r in mica-core mica-podman mica-boards mica-build; do
        checkout "${r}" "$([ "${r}" = "${1:-}" ] && echo fail || true)"
    done
    mkdir -p "${WS}/mica-build/meta/verity" "${WS}/mica-build/meta/boot"
    printf 'verity\n' >"${WS}/mica-build/meta/verity/signer.cert.pem"
    printf 'boot\n' >"${WS}/mica-build/meta/boot/signer.cert.pem"
}
chain() { bash tools/offline-chain.sh --workspace "${WS}" "$@"; }
# The checkouts' own state: every ref, the object and config files of .git, the working tree.
fingerprint() {
    for r in mica-core mica-podman mica-boards mica-build; do
        git -C "${WS}/${r}" for-each-ref
        git -C "${WS}/${r}" status --porcelain --untracked-files=all
        (cd "${WS}/${r}/.git" && find . -type f ! -name index -printf '%P %s\n' | LC_ALL=C sort)
    done | sha256sum
}
refuses() { # <label> <fragment> <args...>
    local label="$1" fragment="$2" out
    shift 2
    if out="$("$@" 2>&1)"; then
        fail "${label}: accepted"
    elif printf '%s' "${out}" | grep -F -- "${fragment}" >/dev/null; then
        pass "${label}: refused naming '${fragment}'"
    else
        fail "${label}: refused, but not naming '${fragment}': ${out}"
    fi
}

# 1. A dry run clones every checkout at its HEAD, plans, builds nothing and writes nothing into the checkouts.
workspace
printf 'uncommitted\n' >"${WS}/mica-core/Makefile.local"
before="$(fingerprint)"
if out="$(chain --dry-run 2>&1)"; then
    run="$(printf '%s\n' "${out}" | sed -n 's/^offline-chain.sh: run //p')"
    ok=1
    for r in mica-core mica-podman mica-boards mica-build; do
        [ "$(git -C "${run}/${r}" rev-parse HEAD)" = "$(git -C "${WS}/${r}" rev-parse HEAD)" ] || ok=0
        [ -f "${run}/${r}/.git/objects/info/alternates" ] || ok=0
    done
    [ "${ok}" = 1 ] && pass "a dry run clones every checkout at its HEAD, sharing its objects" || fail "a dry run: clones not at HEAD or not shared: ${out}"
    [ ! -e "${run}/mica-core/Makefile.local" ] && pass "uncommitted changes of a checkout are not in its clone" || fail "an uncommitted file reached the clone"
    [ ! -e "${OFFLINE_CHAIN_TEST_LOG}" ] && pass "a dry run runs no build" || fail "a dry run ran make offline"
    printf '%s\n' "${out}" | grep -F "plan: make product PRODUCT=x64-dev" >/dev/null && pass "the plan names the default product x64-dev" || fail "no product in the plan: ${out}"
else
    fail "a dry run of a valid workspace: ${out}"
fi
[ "$(fingerprint)" = "${before}" ] && pass "the checkouts are untouched: refs, .git files and working trees" || fail "a checkout changed during the chain"

# 2. The producers run in parallel with the signing certificates, and the summary names every commit and pool.
workspace
if out="$(chain --producers-only --products "x64-dev cx3576-dev" 2>&1)"; then
    run="$(printf '%s\n' "${out}" | sed -n 's/^offline-chain.sh: run //p')"
    starts="$(grep -n '^start' "${OFFLINE_CHAIN_TEST_LOG}" | tail -1 | cut -d: -f1)"
    ends="$(grep -n '^end' "${OFFLINE_CHAIN_TEST_LOG}" | head -1 | cut -d: -f1)"
    [ "$(grep -c '^start' "${OFFLINE_CHAIN_TEST_LOG}")" = 3 ] && [ "${starts}" -lt "${ends}" ] &&
        pass "make offline runs in all three producers, in parallel" || fail "producers not run in parallel: $(cat "${OFFLINE_CHAIN_TEST_LOG}")"
    grep -F "start mica-boards verity=${WS}/mica-build/meta/verity/signer.cert.pem" "${OFFLINE_CHAIN_TEST_LOG}" >/dev/null &&
        pass "the producers get the certificates of the signing workspace" || fail "no certificate handed to the producers: $(cat "${OFFLINE_CHAIN_TEST_LOG}")"
    ! grep -F "start mica-build" "${OFFLINE_CHAIN_TEST_LOG}" >/dev/null && pass "mica-build is not a producer" || fail "make offline ran in mica-build"
    n=0
    for r in mica-core mica-podman mica-boards mica-build; do
        grep -F "$(printf 'commit\t%s\t%s' "${r}" "$(git -C "${WS}/${r}" rev-parse HEAD)")" "${run}/summary.txt" >/dev/null && n=$((n + 1))
    done
    [ "${n}" = 4 ] && [ "$(grep -c "^pool	" "${run}/summary.txt")" = 3 ] && grep -F "SHA256SUMS $(sha256sum "${run}/mica-core/_out/debs/amd64/SHA256SUMS" | cut -d' ' -f1)" "${run}/summary.txt" >/dev/null &&
        pass "the summary names every commit and every producer pool by its SHA256SUMS digest" || fail "summary incomplete: $(cat "${run}/summary.txt")"
    [ "$(grep -c "^duration	" "${run}/summary.txt")" = 3 ] && pass "the summary carries each producer's duration" || fail "durations missing: $(cat "${run}/summary.txt")"
else
    fail "a producers-only chain over valid producers: ${out}"
fi

# 3. Refusals.
workspace mica-podman
refuses "a failing producer" "make offline failed in: mica-podman" chain --producers-only
workspace
refuses "GitHub Actions" "never run in CI" env GITHUB_ACTIONS=true bash tools/offline-chain.sh --workspace "${WS}" --dry-run
rm -rf "${WS}/mica-boards"
refuses "a missing checkout" "${WS}/mica-boards is not a git checkout" chain --dry-run
workspace
rm "${WS}/mica-build/meta/boot/signer.cert.pem"
refuses "a signing workspace without its boot certificate" "boot/signer.cert.pem does not exist" chain --dry-run
refuses "no workspace" "--workspace must name" bash tools/offline-chain.sh --dry-run
refuses "an empty product list" "--products names no product" chain --dry-run --products " "
# The fixture mica-build has no tools/local-pins.sh: the first failing pin stops the chain before any commit.
workspace
refuses "a failing local pin" "pinning the offline builds failed" chain
run="$(ls -d "${WS}"/.mica-offline/* | tail -1)"
[ -z "$(git -C "${run}/mica-build" branch --list "offline/*")" ] && pass "a failing local pin commits no offline branch" || fail "an offline branch was committed after a failing pin"

echo "RESULT: $([ "${FAIL_N}" -eq 0 ] && echo PASS || echo FAIL) (${PASS_N}/$((PASS_N + FAIL_N)) checks passed)"
[ "${FAIL_N}" -eq 0 ]
