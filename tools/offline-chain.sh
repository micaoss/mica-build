#!/usr/bin/env bash
# The offline chain: products built from the side-by-side checkouts' own builds
# instead of their releases.
#
#   bash tools/offline-chain.sh --workspace <dir> [--products "<product> ..."] [--signing <dir>]
#                               [--dry-run | --producers-only]
#
#   reads   <workspace>/{mica-core,mica-podman,mica-build}   the checkouts, at their HEAD commits
#           --signing (default <workspace>/mica-build/meta)             development trust material, read only
#   writes  <workspace>/.mica-offline/<stamp>/<repository>/             throw-away clones and their builds
#           <workspace>/.mica-offline/<stamp>/logs/<step>.log
#           <workspace>/.mica-offline/<stamp>/summary.txt
#
# WHAT IT BUILDS FROM, SAID HERE BECAUSE AN ACCEPTANCE CLAUSE ASSERTED
# SOMETHING THIS TOOL DOES NOT DO. Each producer is built from ITS CHECKOUT'S
# HEAD, not from the commit its release was cut at, and the products are then
# assembled from those offline pins. So a product this chain builds and a
# product a release published differ in their INPUTS unless the checkouts
# happen to sit at the release commits -- which is not checked here and was not
# true on 2026-09-20, when the mica-build checkout was six hours and one repair
# behind main. "THE OFFLINE CHAIN REPRODUCES THE ONLINE BYTES" IS THEREFORE A
# CLAIM ABOUT A WORKSPACE, NOT ABOUT THIS SCRIPT: it holds only from checkouts
# at the release commits, and no run of this chain has ever asserted it. What a
# run here proves is that a product can be built from source without touching a
# release, which is the mechanism and not the equality.
#
# AND AS OF 2026-09-20 IT CANNOT FINISH. The three producers build from source
# in about eleven minutes and then the pinning step fails: src/cli.ts local-pins
# expects an ASSEMBLED BOARD BUNDLE -- _out/boards/<board>/ with an outputs.tsv,
# the layout a fetched bundle has -- while mica-boards' `make offline` produces
# COMPONENT TREES with their inputs hashes and no outputs.tsv, because there
# outputs.tsv is a source file that travels inside the board component. Two
# internally consistent tools describing different things by one path. The
# agreed direction is that mica-boards' offline build assembles a bundle the way
# a release does, so the offline artefact has the shape a consumer fetches and
# the comparison above becomes statable at all.
#
# `make os-offline-chain-test` passes on every push over a FIXTURE workspace
# that does not reach that seam. A test over a fixture that does not reach the
# seam proves the parts and not the join, and the join is where this defect
# lived for six days.
#
# THE CHECKOUTS ARE NEVER WRITTEN. Each is cloned with `git clone --shared`
# (objects read through alternates; nothing is added to its .git) and checked
# out at the HEAD commit it had when the chain started; uncommitted changes in
# a checkout are not part of the build. Every step runs in the clones.
#
# THE ORDER (increment 1 of the offline build): `make offline` in the mica-core,
# mica-podman clones, in parallel; then, in the mica-build clone,
# src/cli.ts local-pins for each of the three (their offline locks and pins in
# locks/), committed on the local branch offline/<stamp>, and `make product`
# for every product. The build-env
# images and mica-system-base still come from their releases. The boards are this tree's own
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

WORKSPACE=""; PRODUCTS="uefi-x64-dev"; SIGNING=""; MODE=build
AT_RELEASE_COMMITS=0
while [ "$#" -gt 0 ]; do
    case "$1" in
    --workspace) WORKSPACE="${2:-}"; shift 2 ;;
    --products) PRODUCTS="${2:-}"; shift 2 ;;
    --signing) SIGNING="${2:-}"; shift 2 ;;
    --dry-run) MODE=dry-run; shift ;;
    --producers-only) MODE=producers-only; shift ;;
    --at-release-commits) AT_RELEASE_COMMITS=1; shift ;;
    *) die "usage: bash tools/offline-chain.sh --workspace <dir> [--products \"...\"] [--signing <dir>] [--dry-run | --producers-only] [--at-release-commits]" ;;
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

PRODUCERS="mica-core mica-podman"
declare -A COMMIT=()
declare -A HEAD_AT=()
for repository in ${PRODUCERS} mica-build; do
    git -C "${WORKSPACE}/${repository}" rev-parse --verify --quiet HEAD >/dev/null 2>&1 ||
        die "${WORKSPACE}/${repository} is not a git checkout with a commit"
    COMMIT["${repository}"]="$(git -C "${WORKSPACE}/${repository}" rev-parse HEAD)"
    HEAD_AT["${repository}"]="${COMMIT[${repository}]}"
done

# *** --at-release-commits BUILDS AT THOSE COMMITS RATHER THAN ONLY REFUSING. ***
#
# The checkouts lend their objects; the clones decide what is built. So the
# aligned mode does not need the workspace to stand at the release commits --
# it needs the OBJECTS to be there, which a `--shared` clone of a checkout that
# has fetched them satisfies. A checkout too far behind to hold one is named
# rather than silently built from HEAD.
#
# ONE CLONE PER DISTINCT RELEASE COMMIT, NOT ONE PER BOARD. mica-boards'
# `make offline` builds EVERY board of its checkout and takes no board
# argument, so a clone per board would build four kernels to keep one. The
# grouping that matters is the commit: when the four boards are released
# together they name ONE commit and one clone serves them all, which is the
# case on 2026-09-20. When they do not, this refuses and names the groups,
# because merging pools built at different commits is a design question and not
# a loop -- each board's packages would come from its own commit and
# local-pins reads one pool per architecture.
if [ "${AT_RELEASE_COMMITS}" -eq 1 ]; then
    for repository in ${PRODUCERS}; do
        commits="$(cd "${WORKSPACE}/mica-build" && bash bin/bun.sh src/cli.ts locks rows release |
            awk -v r="${repository}" '$2 == r { print $4 }' | LC_ALL=C sort -u)"
        n="$(printf '%s\n' "${commits}" | grep -c . || true)"
        [ "${n}" -eq 1 ] ||
            die "${repository} is released at ${n} distinct commits, so no single clone reproduces them: $(printf '%s ' ${commits}). One clone per commit group is the shape; merging pools built at different commits is not implemented"
        git -C "${WORKSPACE}/${repository}" rev-parse --verify --quiet "${commits}^{commit}" >/dev/null 2>&1 ||
            die "${WORKSPACE}/${repository} does not have the object ${commits}, which its release names. Fetch that checkout (this tool never fetches) or the clone would silently be built from something else"
        COMMIT["${repository}"]="${commits}"
    done
fi

# WHERE EACH CHECKOUT SITS RELATIVE TO THE RELEASE IT WOULD HAVE TO REPRODUCE.
# Printed on every run, because the acceptance clause this tool was measured
# against -- "the offline chain reproduces the online bytes" -- is a claim about
# the WORKSPACE and is false unless each checkout is at its release commit. A
# run that does not say where it stands cannot be quoted for that claim, and
# was.
#
# MICA-BOARDS CANNOT SATISFY IT AT ALL TODAY, and this loop is how you see why:
# boards are released independently, so locks/ names a DIFFERENT commit per
# board -- three distinct ones on 2026-09-20. ONE WORKING TREE CANNOT BE AT
# THREE COMMITS. Reproducing release bytes therefore needs one clone per board
# rather than one clone of mica-boards, which is a change to the step below and
# not to this report. The report exists so the impossibility is visible before
# eleven minutes of building rather than after.
declare -A RELEASED=()
while IFS=$'\t' read -r input repository release commit; do
    [ -n "${input}" ] || continue
    RELEASED["${input}"]="${release} ${commit}"
done < <(cd "${WORKSPACE}/mica-build" && bash bin/bun.sh src/cli.ts locks rows release)
ALIGNED=1
for repository in ${PRODUCERS}; do
    named=""
    for input in "${!RELEASED[@]}"; do
        case "${input}" in "${repository}" | "${repository}".*) named="${named}${input}=${RELEASED[${input}]}
" ;; esac
    done
    commits="$(printf '%s' "${named}" | awk 'NF { print $NF }' | LC_ALL=C sort -u)"
    n="$(printf '%s\n' "${commits}" | grep -c . || true)"
    if [ "${n}" -ne 1 ]; then
        ALIGNED=0
        say "checkout ${repository}: HEAD ${COMMIT[${repository}]} -- locks/ names ${n} release commits for this producer, so NO single checkout is at its releases:"
        printf '%s' "${named}" | sed 's/^/offline-chain.sh:   /'
    elif [ "${AT_RELEASE_COMMITS}" -eq 1 ]; then
        say "checkout ${repository}: building at the release commit ${commits} (this checkout's HEAD is ${HEAD_AT[${repository}]})"
    elif [ "${commits}" = "${COMMIT[${repository}]}" ]; then
        say "checkout ${repository}: HEAD is the release commit ${commits}"
    else
        ALIGNED=0
        say "checkout ${repository}: HEAD ${COMMIT[${repository}]} is NOT the release commit ${commits}"
    fi
done
[ "${ALIGNED}" -eq 1 ] || say "THIS RUN CANNOT BE QUOTED FOR BYTE EQUALITY WITH ANY RELEASE. It proves a product can be built from source without touching a release, which is the mechanism and not the equality."
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
    say "plan: in mica-build, src/cli.ts local-pins ${PRODUCERS// /, }; commit on offline/${STAMP}"
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
        bash bin/bun.sh src/cli.ts local-pins "${repository}" "${RUN}/${repository}" || exit 1
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
        arch="$(bash tools/boards.sh arch "${board}")" || exit 1
        bash tools/pool.sh fetch --arch "${arch}" || exit 1
        bash tools/pool.sh index --arch "${arch}" || exit 1
        make product PRODUCT="${p}" || exit 1
    ) >"${RUN}/logs/product-${p}.log" 2>&1 || { tail -n 20 "${RUN}/logs/product-${p}.log" >&2; die "product ${p} failed (${RUN}/logs/product-${p}.log)"; }
    DURATION["product:${p}"]="$(seconds "${start}")"
    say "product ${p} built in ${DURATION[product:${p}]} s"
done
summary
