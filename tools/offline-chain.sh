#!/usr/bin/env bash
# The offline chain: products built from the side-by-side checkouts' own builds
# instead of their releases.
#
#   bash tools/offline-chain.sh --workspace <dir> [--products "<product> ..."] [--signing <dir>]
#                               [--dry-run | --producers-only]
#
#   reads   <workspace>/{mica-core,mica-podman,mica-boards,mica-build}   the checkouts, at their HEAD commits
#           --signing (default <workspace>/mica-build/meta)             development trust material, read only
#   writes  <workspace>/.mica-offline/<stamp>/<repository>/             throw-away clones and their builds
#           <workspace>/.mica-offline/<stamp>/logs/<step>.log
#           <workspace>/.mica-offline/<stamp>/summary.txt
#
# THE CHECKOUTS ARE NEVER WRITTEN. Each is cloned with `git clone --shared`
# (objects read through alternates; nothing is added to its .git) and checked
# out at the HEAD commit it had when the chain started; uncommitted changes in
# a checkout are not part of the build. Every step runs in the clones.
#
# THE ORDER (increment 1 of the offline build): `make offline` in the mica-core,
# mica-podman and mica-boards clones, in parallel; then, in the mica-build clone,
# tools/local-pins.sh for each of the three (their offline locks and pins in
# locks/), committed on the local branch offline/<stamp>, and `make product`
# for every product. The build-env
# images and mica-system-base still come from their releases. mica-boards
# builds its kernels against the certificates of --signing, which the products
# are then signed with.
#
# --dry-run clones and prints the plan without building; --producers-only stops
# after the producers. Refused under GitHub Actions: nothing an offline chain
# builds is a release input.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "offline-chain.sh: error: $*" >&2; exit 1; }
say() { echo "offline-chain.sh: $*"; }

WORKSPACE=""; PRODUCTS="x64-dev"; SIGNING=""; MODE=build
while [ "$#" -gt 0 ]; do
    case "$1" in
    --workspace) WORKSPACE="${2:-}"; shift 2 ;;
    --products) PRODUCTS="${2:-}"; shift 2 ;;
    --signing) SIGNING="${2:-}"; shift 2 ;;
    --dry-run) MODE=dry-run; shift ;;
    --producers-only) MODE=producers-only; shift ;;
    *) die "usage: bash tools/offline-chain.sh --workspace <dir> [--products \"...\"] [--signing <dir>] [--dry-run | --producers-only]" ;;
    esac
done
[ -z "${GITHUB_ACTIONS:-}" ] || die "an offline chain is never run in CI: its builds are not release inputs"
[ -n "${WORKSPACE}" ] && [ -d "${WORKSPACE}" ] || die "--workspace must name the directory that holds the checkouts"
WORKSPACE="$(cd "${WORKSPACE}" && pwd)"
[ -n "${PRODUCTS// /}" ] || die "--products names no product"
SIGNING="$(cd "${SIGNING:-${WORKSPACE}/mica-build/meta}" 2>/dev/null && pwd)" || die "the signing workspace ${SIGNING:-${WORKSPACE}/mica-build/meta} does not exist"
for f in verity/signer.cert.pem boot/signer.cert.pem; do
    [ -f "${SIGNING}/${f}" ] || die "${SIGNING}/${f} does not exist"
done

PRODUCERS="mica-core mica-podman mica-boards"
declare -A COMMIT=()
for repository in ${PRODUCERS} mica-build; do
    git -C "${WORKSPACE}/${repository}" rev-parse --verify --quiet HEAD >/dev/null 2>&1 ||
        die "${WORKSPACE}/${repository} is not a git checkout with a commit"
    COMMIT["${repository}"]="$(git -C "${WORKSPACE}/${repository}" rev-parse HEAD)"
done

STAMP="$(date -u +%Y%m%d-%H%M%S)"
RUN="${WORKSPACE}/.mica-offline/${STAMP}"
[ ! -e "${RUN}" ] || die "${RUN} already exists"
mkdir -p "${RUN}/logs"
say "run ${RUN}"

# Clones at the recorded commits; the checkouts only lend their objects.
for repository in ${PRODUCERS} mica-build; do
    git clone --quiet --shared --no-checkout "${WORKSPACE}/${repository}" "${RUN}/${repository}"
    git -C "${RUN}/${repository}" checkout --quiet --detach "${COMMIT[${repository}]}"
    say "clone ${repository} at ${COMMIT[${repository}]}"
done

seconds() { local start="$1"; echo $(( $(date +%s) - start )); }
declare -A DURATION=()
plan() {
    say "plan: in parallel, make offline in ${PRODUCERS}"
    say "plan: in mica-build, tools/local-pins.sh ${PRODUCERS// /, }; commit on offline/${STAMP}"
    for p in ${PRODUCTS}; do say "plan: make product PRODUCT=${p}"; done
}
plan
if [ "${MODE}" = dry-run ]; then
    say "dry run: nothing built"
    exit 0
fi

# The producers, in parallel, each with its own log.
declare -A PID=() START=()
for repository in ${PRODUCERS}; do
    START["${repository}"]="$(date +%s)"
    (
        cd "${RUN}/${repository}" || exit 1
        VERITY_TRUST_CERT="${SIGNING}/verity/signer.cert.pem" FIT_TRUST_CERT="${SIGNING}/boot/signer.cert.pem" make offline
    ) >"${RUN}/logs/${repository}.log" 2>&1 &
    PID["${repository}"]=$!
    say "started make offline in ${repository} (log ${RUN}/logs/${repository}.log)"
done
failed=""
for repository in ${PRODUCERS}; do
    if wait "${PID[${repository}]}"; then
        DURATION["${repository}"]="$(seconds "${START[${repository}]}")"
        say "${repository}: make offline done in ${DURATION[${repository}]} s"
    else
        failed="${failed} ${repository}"
        echo "offline-chain.sh: ${repository}: make offline failed; the end of ${RUN}/logs/${repository}.log:" >&2
        tail -n 20 "${RUN}/logs/${repository}.log" >&2
    fi
done
[ -z "${failed}" ] || die "make offline failed in:${failed}"

summary() {
    {
        echo "# offline chain ${STAMP}: ${RUN}"
        for repository in ${PRODUCERS} mica-build; do
            printf 'commit\t%s\t%s\n' "${repository}" "${COMMIT[${repository}]}"
        done
        for repository in ${PRODUCERS}; do
            printf 'duration\t%s\t%s s\n' "${repository}" "${DURATION[${repository}]}"
            for sums in "${RUN}/${repository}"/_out/debs/*/SHA256SUMS; do
                [ -f "${sums}" ] || continue
                printf 'pool\t%s\t%s\t%s archives\tSHA256SUMS %s\n' "${repository}" "$(basename "$(dirname "${sums}")")" \
                    "$(grep -c . "${sums}")" "$(sha256sum "${sums}" | cut -d' ' -f1)"
            done
        done
        for p in ${PRODUCTS}; do
            [ -n "${DURATION[product:${p}]:-}" ] || continue
            printf 'duration\tproduct %s\t%s s\n' "${p}" "${DURATION[product:${p}]}"
            out="${RUN}/mica-build/_out/products/${p}"
            while read -r _ image; do
                printf 'image\t%s\t%s\t%s bytes\t%s\n' "${p}" "${out}/image/${image}" "$(stat -c %s "${out}/image/${image}")" "$(sha256sum "${out}/image/${image}" | cut -d' ' -f1)"
            done <"${out}/image/SHA256SUMS"
            printf 'update\t%s\t%s\t%s bytes\t%s\n' "${p}" "${out}/update.micaupd" "$(stat -c %s "${out}/update.micaupd")" "$(sha256sum "${out}/update.micaupd" | cut -d' ' -f1)"
        done
    } >"${RUN}/summary.txt"
    cat "${RUN}/summary.txt"
}
if [ "${MODE}" = producers-only ]; then
    summary
    exit 0
fi

# The assembly: the producers' pools pinned locally, then the products. Every
# command in these subshells ends in `|| exit 1`: errexit does not apply inside a
# subshell whose status is tested.
BUILD="${RUN}/mica-build"
export MICA_SIGNING_OUTPUT="${SIGNING}" MICA_VERITY_TRUST_CERT="${SIGNING}/verity/signer.cert.pem"
(
    cd "${BUILD}" || exit 1
    for repository in ${PRODUCERS}; do
        bash tools/local-pins.sh "${repository}" "${RUN}/${repository}" || exit 1
    done
    git checkout --quiet -b "offline/${STAMP}" || exit 1
    git add -A -- locks || exit 1
    git -c user.name=offline-chain -c user.email=offline-chain@localhost commit --quiet -m "LOCAL ONLY: offline chain ${STAMP}: ${PRODUCERS} from their offline builds" || exit 1
) >"${RUN}/logs/local-pins.log" 2>&1 || { tail -n 20 "${RUN}/logs/local-pins.log" >&2; die "pinning the offline builds failed (${RUN}/logs/local-pins.log)"; }
say "mica-build: local pins committed on offline/${STAMP} ($(git -C "${BUILD}" rev-parse --short HEAD))"
for p in ${PRODUCTS}; do
    start="$(date +%s)"
    (
        cd "${BUILD}" || exit 1
        # The architecture of the product's board: its board row.
        board="$(sed -n 's/^BOARD=//p' "products/${p}/product.env" | tr -d '"')" && [ -n "${board}" ] || exit 1
        arch="$(python3 tools/locks.py rows board | awk -F'\t' -v b="${board}" '$2 == b && $3 == "board" { print $4 }')" && [ -n "${arch}" ] || exit 1
        bash tools/pool.sh fetch --arch "${arch}" || exit 1
        bash tools/pool.sh index --arch "${arch}" || exit 1
        make product PRODUCT="${p}" || exit 1
    ) >"${RUN}/logs/product-${p}.log" 2>&1 || { tail -n 20 "${RUN}/logs/product-${p}.log" >&2; die "product ${p} failed (${RUN}/logs/product-${p}.log)"; }
    DURATION["product:${p}"]="$(seconds "${start}")"
    say "product ${p} built in ${DURATION[product:${p}]} s"
done
summary
