#!/usr/bin/env bash
# The UEFI lifecycle suite over a built product: assemble the acceptance
# disk, boot it once and read the runtime and shutdown evidence, then the
# update and fault stages over fresh copies.
#
#   bash tests/suites/lifecycle-uefi/run.sh <product>                  (make lifecycle-uefi PRODUCT=<product>)
#   bash tests/suites/lifecycle-uefi/run.sh <product> --runtime-only   stages 1 and 2 alone: the disk and one boot
#
# --runtime-only is what ci.yml runs as a gate beside the product it has just
# built: the boot is the cheap half (about half a minute; the lab images it
# needs are the expensive half and they cache), while the update and fault
# stages are minutes. One boot answers the question a static image check
# cannot -- whether the thing starts -- and that is the question a rename of
# the boards went three days without anyone asking.
#
# The product names the board, the root, the kernel bundle, the lifecycle
# binary and the signing workspace (product-inputs.sh); the board's facts
# say which emulator the lab boots. Evidence is left under
# _out/file-runtime.*/ and the path is the last line printed.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
product=${1:?product name required}
runtime_only=""
case "${2:-}" in
'') ;;
--runtime-only) runtime_only=1 ;;
*) echo "usage: bash tests/suites/lifecycle-uefi/run.sh <product> [--runtime-only]" >&2; exit 1 ;;
esac
eval "$(bash tests/suites/lifecycle-uefi/product-inputs.sh "${product}")"
arch="$(sed -n 's/^MICA_ARCH=//p' "_out/boards/${BOARD}/board.env")"
bash tests/signed-boot-lab/images.sh --lifecycle >/dev/null

echo "== 1. the acceptance disk (runtime-build.sh) =="
evidence="$(bash tests/suites/lifecycle-uefi/runtime-build.sh "${ROOT_IMAGE}" "${KERNEL_DIR}" "${CERT}" "${KEY}" "${RUNKIT}" "${BOARD}" | tail -n1)"
[ -d "${evidence}/image" ] || { echo "error: runtime-build.sh left no evidence directory (${evidence})" >&2; exit 1; }
echo "evidence: ${evidence}"

echo "== 2. the runtime boot: full services, the writable namespace policy, an ordered shutdown =="
timeout -k 10 400 docker run --rm --label ai-agent=true --network traefik -v "${evidence}:/w" \
    -v "$PWD/tests/suites/lifecycle-uefi:/harness:ro" ai-agent/mica-p2-lab \
    bash /harness/boot.sh image/disk.img writable 300 "${arch}" >"${evidence}/runtime.log" 2>&1 || true
grep -F FILE_AB_RUNTIME_PASS "${evidence}/runtime.log" >/dev/null || { echo "error: the runtime boot did not report FILE_AB_RUNTIME_PASS; see ${evidence}/runtime.log" >&2; exit 1; }
bash tests/suites/lifecycle-uefi/shutdown-check.sh "${evidence}/runtime.log" poweroff
echo "PASS: runtime boot and ordered shutdown (${evidence}/runtime.log)"
if [ -n "${runtime_only}" ]; then
    echo "RESULT: PASS (lifecycle-uefi on ${product}: build and runtime; updates and faults not run)"
    printf '%s\n' "${evidence}"
    exit 0
fi

echo "== 3. component updates over a fresh copy (updates.sh) =="
bash tests/suites/lifecycle-uefi/updates.sh "${evidence}" "${CERT}" "${KEY}" "${RUNKIT}" "${BOARD}" >"${evidence}/updates.log" 2>&1 || { echo "error: updates.sh failed; see ${evidence}/updates.log" >&2; tail -n 20 "${evidence}/updates.log" >&2; exit 1; }
echo "PASS: updates (${evidence}/updates.log)"

echo "== 4. faults over fresh copies (faults.sh, inside the lab) =="
timeout -k 10 1200 docker run --rm --label ai-agent=true --network traefik -v "${evidence}:/w" \
    -v "$PWD/tests/suites/lifecycle-uefi:/lab:ro" ai-agent/mica-p2-lab \
    bash /lab/faults.sh "${arch}" >"${evidence}/faults.log" 2>&1 || { echo "error: faults.sh failed; see ${evidence}/faults.log" >&2; tail -n 20 "${evidence}/faults.log" >&2; exit 1; }
echo "PASS: faults (${evidence}/faults.log)"

echo "RESULT: PASS (lifecycle-uefi on ${product}: build, runtime, updates, faults)"
printf '%s\n' "${evidence}"
