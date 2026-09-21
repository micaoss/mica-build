#!/usr/bin/env bash
# The whole build of this checkout, locally: what CI builds, from the clean
# commit and the inputs it pins, with nothing published.
#
#   make offline                    (docker; on an x64 host the arm64 pool is emulated)
#
#   reads   meta/verity/signer.cert.pem, meta/boot/signer.cert.pem   (or VERITY_TRUST_CERT, FIT_TRUST_CERT:
#                                                                      the public certificates, which must be
#                                                                      the ones trust-certificates.sha256 records)
#   writes  _out/<board>/                     every board's kernel and firmware (make kernels firmware)
#           _out/debs/<amd64|arm64>/          both pools: pool/, Packages, SHA256SUMS, manifest.txt (make pool),
#                                             gated per architecture and across both (make package-gate)
#           _out/components/<board>/<component>/  each board's components (tools/component.sh: board,
#                                             kernel, uboot, firmware), each with its inputs hash beside it
#           _out/boards/<board>/              THE ASSEMBLED BUNDLE: the same shape a consumer FETCHES from a
#                                             release -- the board component's files at the root, kernel/,
#                                             uboot/ and firmware/ beside them, outputs.tsv among them --
#                                             verified against outputs.tsv as a whole
#
# The boards are boards/boards.tsv's, and each one's outputs must be what its
# outputs.tsv lists: the archives of its pool and exactly each component's files.
#
# A dirty tree is refused: every archive carries the commit it was built from.
# _out/debs, _out/boards and _out/components are replaced, so they hold only this commit's build.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${HERE}/.." && pwd)"
cd "${REPO_ROOT}"
die() { echo "offline.sh: error: $*" >&2; exit 1; }

[ -z "$(git status --porcelain --untracked-files=no)" ] || die "the tree has uncommitted changes; commit them, then build"
bash tools/boards.sh check
commit="$(git rev-parse HEAD)"

VERITY="$(realpath "${VERITY_TRUST_CERT:-meta/verity/signer.cert.pem}")" || die "no verity certificate at ${VERITY_TRUST_CERT:-meta/verity/signer.cert.pem}"
FIT="$(realpath "${FIT_TRUST_CERT:-meta/boot/signer.cert.pem}")" || die "no FIT boot certificate at ${FIT_TRUST_CERT:-meta/boot/signer.cert.pem}"
for pair in "meta/verity/signer.cert.pem:${VERITY}" "meta/boot/signer.cert.pem:${FIT}"; do
    want="$(sed -n "s|^\([0-9a-f]\{64\}\)  ${pair%%:*}\$|\1|p" trust-certificates.sha256)"
    [ -n "${want}" ] || die "trust-certificates.sha256 records no ${pair%%:*}"
    [ "$(sha256sum "${pair#*:}" | cut -d' ' -f1)" = "${want}" ] || die "${pair#*:} is not the certificate trust-certificates.sha256 records for ${pair%%:*}"
done

rm -rf _out/debs _out/boards _out/components
make kernels firmware VERITY_TRUST_CERT="${VERITY}" FIT_TRUST_CERT="${FIT}"
VERITY_TRUST_CERT="${VERITY}" make pool
make package-gate GATE_ARGS="--arch amd64"
make package-gate GATE_ARGS="--arch arm64"
make package-gate GATE_ARGS=--static
# The version guard compares with a published release, which an offline build does not read.
echo "offline.sh: warning: the package-version guard (tools/deb/version-guard.sh) is not run offline; packages carry their declared versions, unchecked against the latest releases"

for board in $(bash tools/boards.sh list); do
    arch="$(bash tools/boards.sh arch "${board}")"
    bash tools/boards.sh pool-has "${board}" "_out/debs/${arch}/pool"
    mkdir -p "_out/boards/${board}"
    for component in $(bash tools/component.sh list "${board}"); do
        VERITY_TRUST_CERT="${VERITY}" bash tools/component.sh stage "${board}" "${component}" "_out/components/${board}/${component}"
        VERITY_TRUST_CERT="${VERITY}" FIT_TRUST_CERT="${FIT}" bash tools/inputs.sh "${board}" "${component}" >"_out/components/${board}/${component}.inputs.sha256"
        # ...and into the bundle. A component's paths are already bundle-relative
        # (the board component's at the root, kernel/ under kernel), so the
        # components compose into exactly the tree a release publishes.
        cp -a "_out/components/${board}/${component}/." "_out/boards/${board}/"
    done
    # AN OFFLINE BUILD ASSEMBLES THE SAME BUNDLE A RELEASE DOES. Without this,
    # a consumer building from source meets component trees and a consumer
    # building from a release meets a bundle, so it needs two readers and only
    # one of them is ever exercised (mica-build's local-pins.sh reads the
    # bundle; it could not read what this produced before 2026-09-20).
    bash tools/boards.sh bundle-is "${board}" "_out/boards/${board}"
done

echo "offline.sh: built ${commit}"
echo "offline.sh: kernels and firmware  ${REPO_ROOT}/_out/<board>/"
for a in amd64 arm64; do
    echo "offline.sh: ${a} pool  ${REPO_ROOT}/_out/debs/${a}/ ($(grep -c . "_out/debs/${a}/SHA256SUMS") archives)"
done
for board in $(bash tools/boards.sh list); do
    echo "offline.sh: ${board} ($(bash tools/boards.sh arch "${board}"))  pool ${REPO_ROOT}/_out/debs/$(bash tools/boards.sh arch "${board}")/ ($(bash tools/boards.sh packages "${board}" | wc -l) archives listed), bundle ${REPO_ROOT}/_out/boards/${board}/ (components ${REPO_ROOT}/_out/components/${board}/{$(bash tools/component.sh list "${board}" | paste -sd, -)}/)"
done
