#!/usr/bin/env bash
# The disk kind: the raw factory image the image component wrote (build/run.sh --components image).
#
#   bash tools/image-kinds/disk.sh <product out>      prints image/<the image SHA256SUMS names>
#
# The image is the one image/SHA256SUMS lists first, and must hash to it.
set -euo pipefail
out="${1:?usage: bash tools/image-kinds/disk.sh <product out>}"
sums="${out}/image/SHA256SUMS"
[ -s "${sums}" ] || { echo "error: ${sums} does not exist; the image component was not built" >&2; exit 1; }
read -r sha name <"${sums}"
[ -n "${name}" ] && [ -f "${out}/image/${name}" ] && [ "$(sha256sum "${out}/image/${name}" | cut -d' ' -f1)" = "${sha}" ] ||
    { echo "error: ${out}/image/${name:-?} is not the image ${sums} names at ${sha:-?}" >&2; exit 1; }
printf 'image/%s\n' "${name}"
