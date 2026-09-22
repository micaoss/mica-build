#!/usr/bin/env bash
# The lifecycle suite's inputs, out of a built product: what runtime-build.sh
# and its siblings take as six positional arguments, derived from
# _out/products/<name>/ (make product) and the signing workspace, so the
# suite is keyed by the product and not by a board name typed beside it.
#
#   eval "$(bash tests/suites/lifecycle-uefi/product-inputs.sh <name>)"
#   bash tests/suites/lifecycle-uefi/runtime-build.sh "$ROOT_IMAGE" "$KERNEL_DIR" "$CERT" "$KEY" "$RUNKIT" "$BOARD"
#
# UEFI boards only: this suite boots through OVMF/AAVMF; a FIT board's
# lifecycle is tests/suites/lifecycle-uboot-fit/.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../.."
NAME="${1:?product name required}"
eval "$(bash tools/product.sh "${NAME}")"
# NO SUITE IN THIS TREE BOOTS A FIT BOARD. tests/suites/lifecycle-uboot-fit is not the
# FIT counterpart of this one: it checks the FIT boot PATH from the host --
# firmware records, persistent attempt IO, signature refusal, trust -- and
# starts nothing. This message used to name it "for the other", which reads as
# though a FIT image were booted somewhere, and that sentence is where the
# author of this correction learnt the wrong thing.
grep -qx 'BOOT_BACKEND=systemd-boot' "${BOARD_DIR}/board.env" || { echo "error: product ${NAME} is on ${BOARD}, which boots a FIT; this suite boots UEFI boards, and nothing in this tree boots a FIT board (tests/suites/lifecycle-uboot-fit checks the FIT boot path host-side and starts no image)" >&2; exit 1; }
OUT="_out/products/${NAME}"
# MICA_SIGNING_OUTPUT is absolute where a release job sets it and relative where
# the default answers, and the rows below are absolute paths the lab mounts. So
# it is made absolute HERE, once: prefixing $PWD unconditionally produced
# "$PWD/$PWD/_out/release-signing/..." in CI, and the existence loop below did
# not catch it because that loop reads ${SIGNING} unprefixed -- the check passed
# on the file the use could not find.
case "${MICA_SIGNING_OUTPUT:-meta}" in
/*) SIGNING="${MICA_SIGNING_OUTPUT}" ;;
*) SIGNING="$PWD/${MICA_SIGNING_OUTPUT:-meta}" ;;
esac
for f in "${OUT}/root/rootfs.img" "${OUT}/lifecycle/mica-runkit" "${BOARD_DIR}/kernel/kernel.release" "${SIGNING}/verity/signer.cert.pem" "${SIGNING}/verity/signer.key.pem"; do
    [ -e "${f}" ] || { echo "error: ${f} does not exist; build the product first (make product PRODUCT=${NAME})" >&2; exit 1; }
done
printf 'ROOT_IMAGE=%q\nKERNEL_DIR=%q\nCERT=%q\nKEY=%q\nRUNKIT=%q\nBOARD=%q\n' \
    "$PWD/${OUT}/root/rootfs.img" "${BOARD_DIR}/kernel" "${SIGNING}/verity/signer.cert.pem" "${SIGNING}/verity/signer.key.pem" \
    "$PWD/${OUT}/lifecycle/mica-runkit" "${BOARD}"
