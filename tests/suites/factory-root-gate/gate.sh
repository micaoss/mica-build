#!/usr/bin/env bash
# Is the OCI export of the factory root the same tree as the image that ships?
#
#   bash tests/suites/factory-root-gate/gate.sh _out/products/<product>/build
#
# `make os-factory-root-gate` runs this, and so does the deep lane in
# .github/workflows/privileged.yml -- the only place it can run on cx3576. The
# invariant it checks is the one every smoke-run result rests on, and nothing
# else checks it. README.md here carries the reasoning in full.
#
# It runs in a container because neither side of the comparison is readable on
# the build host: there is no unsquashfs and no getcap. src/verify/tools.ts
# answers the same problem the same way, and this uses ITS image key and ITS
# package list, so a difference here cannot be a difference between two versions
# of squashfs-tools.
#
# It always runs mutate.sh, because a comparison nobody has watched fail is not
# a check: the capability comparison in particular has nothing behind it on a
# root that carries no file capabilities, where it compares an empty file with
# an empty file and reports agreement. Proving each comparison can fail is part
# of the gate.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${HERE}/../../.." && pwd)"
for anchor in "${HERE}/inner.sh" "${HERE}/mutate.sh" "${REPO}/tools/from.sh"; do
    [ -e "${anchor}" ] || {
        echo "error: ${anchor} does not exist." >&2
        echo "       This script computed HERE=${HERE} and REPO=${REPO} from its own location;" >&2
        echo "       either this directory moved and that arithmetic is stale, or the anchor did." >&2
        exit 1
    }
done

out="${1:?the build directory of the product is required: _out/products/<product>/build}"
[ -d "${out}" ] || {
    echo "error: ${out} is not a directory. Build a root first:" >&2
    echo "         make os-rootfs PRODUCT=<product>" >&2
    exit 1
}
out="$(cd "${out}" && pwd)"
work="${2:-${out}/gate-work}"

# Resolved before the container starts rather than inside it: a key that does
# not resolve is a question about locks/mica-build-env.lock, and answering it from
# inside a container nobody could start is two problems instead of one.
image="$(bash "${REPO}/tools/from.sh" --ref upstream:alpine:3.24.1)"
[ -n "${image}" ] || {
    echo "error: tools/from.sh --ref upstream:alpine:3.24.1 resolved to nothing." >&2
    echo "       That would reach docker as \`docker run \"\" ...\`, which fails with a message" >&2
    echo "       about an invalid reference and not about a missing pin." >&2
    exit 1
}
echo "gate: ${image}"
echo "gate: comparing ${out}/factory-root.oci against ${out}/rootfs-verity.img"

# The package list is src/verify/tools.ts's TOOL_PACKAGES, plus findutils.
# findutils is NOT decoration: alpine's busybox `find` has no -printf, and every
# inventory below is a -printf. Without it the comparison does not fail, it
# prints busybox's usage and the script dies mid-way -- which was measured.
PKGS="bash coreutils diffutils findutils squashfs-tools cryptsetup libcap libcap-setcap tar"

docker run --rm \
    -v "${REPO}:${REPO}" -w "${REPO}" \
    "${image}" \
    sh -c "apk add --no-cache -q ${PKGS} >/dev/null \
        && bash ${HERE}/inner.sh '${out}' '${work}' \
        && bash ${HERE}/mutate.sh '${work}'"
