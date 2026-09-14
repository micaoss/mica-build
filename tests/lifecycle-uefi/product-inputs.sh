#!/usr/bin/env bash
# The lifecycle suite's inputs, out of a built product: what runtime-build.sh
# and its siblings take as six positional arguments, derived from
# _out/products/<name>/ (make product) and the signing workspace, so the
# suite is keyed by the product and not by a board name typed beside it.
#
#   eval "$(bash tests/lifecycle-uefi/product-inputs.sh <name>)"
#   bash tests/lifecycle-uefi/runtime-build.sh "$ROOT_IMAGE" "$KERNEL_DIR" "$CERT" "$KEY" "$RUNKIT" "$BOARD"
#
# UEFI boards only: this suite boots through OVMF/AAVMF; a FIT board's
# lifecycle is tests/lifecycle-uboot-fit/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
NAME="${1:?product name required}"
eval "$(bash tools/product.sh "${NAME}")"
grep -qx 'BOOT_BACKEND=systemd-boot' "${BOARD_DIR}/board.env" || { echo "error: product ${NAME} is on ${BOARD}, which boots a FIT; this suite boots UEFI boards (tests/lifecycle-uboot-fit for the other)" >&2; exit 1; }
OUT="_out/products/${NAME}"
SIGNING="${MICA_SIGNING_OUTPUT:-meta}"
for f in "${OUT}/root/rootfs.img" "${OUT}/lifecycle/mica-runkit" "${BOARD_DIR}/kernel/kernel.release" "${SIGNING}/verity/signer.cert.pem" "${SIGNING}/verity/signer.key.pem"; do
    [ -e "${f}" ] || { echo "error: ${f} does not exist; build the product first (make product PRODUCT=${NAME})" >&2; exit 1; }
done
printf 'ROOT_IMAGE=%q\nKERNEL_DIR=%q\nCERT=%q\nKEY=%q\nRUNKIT=%q\nBOARD=%q\n' \
    "$PWD/${OUT}/root/rootfs.img" "${BOARD_DIR}/kernel" "$PWD/${SIGNING}/verity/signer.cert.pem" "$PWD/${SIGNING}/verity/signer.key.pem" \
    "$PWD/${OUT}/lifecycle/mica-runkit" "${BOARD}"
