#!/usr/bin/env bash
# Boot a built product and let it check itself, the way a person would.
#
#   bash tests/session-probe/run.sh <product>     (make os-session-probe PRODUCT=<name>)
#
# Every gate this tree had before 2026-09-20 observed an image from outside it:
# the image contract reads the assembled bytes, the lifecycle suite boots and
# powers off, the API suite talks to apid over a socket. NONE OF THEM EVER USED
# THE SYSTEM. The defect that put a user in front of a console that answered
# "PAM failure, aborting" was invisible to all of them and would have been
# caught by any one of the claims probe.sh makes.
#
# The probe is seeded into DATA as a unit and writes to the console; this script
# reads its PASS and FAIL lines back. UEFI boards only, as the QEMU suites are.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
REPO_ROOT=$PWD
product=${1:?product name required}
eval "$(bash tools/product.sh "${product}")"
grep -qx 'BOOT_BACKEND=systemd-boot' "${BOARD_DIR}/board.env" ||
    { echo "error: ${product} is on ${BOARD}, which boots a FIT; nothing in this tree boots a FIT board" >&2; exit 1; }
out="_out/products/${product}"
image="${out}/image/$(awk 'NR == 1 { print $2 }' "${out}/image/SHA256SUMS")"
[ -f "${image}" ] || { echo "error: ${image} does not exist; build the product first (make product PRODUCT=${product})" >&2; exit 1; }
signing="${MICA_SIGNING_OUTPUT:-meta}"
case "${signing}" in /*) ;; *) signing="$PWD/${signing}" ;; esac
console="${out}/session-probe.console.log"
port_image="$(bash tests/apid-api/port-image.sh --build)"
qemu() {
    local reuse="$1"
    shift
    docker run --rm --label ai-agent=true --network "${MICA_QEMU_NETWORK:-traefik}" \
        -v "${REPO_ROOT}:${REPO_ROOT}" -v /var/run/docker.sock:/var/run/docker.sock \
        -w "${REPO_ROOT}/tests/apid-api" \
        -e "MICA_BOARD=${BOARD}" -e "MICA_PRODUCT=${product}" \
        -e "MICA_QEMU_IMAGE=${REPO_ROOT}/${image}" -e "MICA_QEMU_BOOT_CERT=${signing}/boot/signer.cert.pem" \
        -e MICA_QEMU_FORWARD=1 -e "MICA_QEMU_NETWORK=${MICA_QEMU_NETWORK:-traefik}" \
        -e "MICA_QEMU_RUN_SECONDS=${MICA_SESSION_RUN_SECONDS:-420}" -e MICA_QEMU_TIMEOUT=900 \
        ${reuse:+-e MICA_QEMU_REUSE_DISK=1} \
        "${port_image}" bun run src/qemu.ts "$@"
}
qemu "" --prepare-only >/dev/null
qemu 1 --seed "${REPO_ROOT}/tests/session-probe/probe.sh" /state/mica-session-probe.sh \
    "${REPO_ROOT}/tests/session-probe/probe.service" /state/systemd-units/mica-session-probe.service \
    --enable mica-session-probe.service >/dev/null
qemu 1 --capture "${REPO_ROOT}/${console}" || true
# The console is the evidence. A boot that never reached the probe is a failure
# of this suite, not a pass with nothing in it.
# NOT ANCHORED, AND CARRIAGE RETURNS STRIPPED. The probe writes to the same
# console systemd and the getty use, so a line arrives prefixed by a login
# prompt or by a terminal reset -- the first run of this suite read four of its
# own seven passes for exactly that reason and called a green probe a failure.
lines="$(tr -d '\r' < "${console}")"
passes=$(printf '%s\n' "${lines}" | { grep -c 'PROBE-PASS: ' || true; })
fails=$(printf '%s\n' "${lines}" | { grep -c 'PROBE-FAIL: ' || true; })
printf '%s\n' "${lines}" | sed -n 's/^.*\(PROBE-\(PASS\|FAIL\): .*\)$/  \1/p'
# `grep -c ... >/dev/null` and not `grep -q`: -q exits at the first match, the
# producer dies of SIGPIPE, and under pipefail the pipeline reports FAILURE
# BECAUSE THE PATTERN WAS FOUND. tests/shell-pipefail-lint.sh refuses that shape
# by name, and it refused this line -- which I pushed, because I had run the
# lint through `| tail -1` and read a summary whose exit status the pipe had
# already thrown away. The lint about swallowed statuses, swallowed.
printf '%s\n' "${lines}" | { grep -c 'PROBE-END' >/dev/null; } ||
    { echo "RESULT: FAIL (the probe never finished; console: ${console})"; exit 1; }
[ "${fails}" -eq 0 ] && [ "${passes}" -ge 12 ] ||
    { echo "RESULT: FAIL (${passes} pass, ${fails} fail; console: ${console})"; exit 1; }
echo "RESULT: PASS (${passes} claims checked from inside the running image; console: ${console})"
