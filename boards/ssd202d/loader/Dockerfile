# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# The SSD202D loader, cross-built for 32-bit Arm from the board's tree of the MStar U-Boot fork in
# micaoss/mica-uboot (mainline U-Boot has no MStar support): the SPL the vendor IPL loads, which loads U-Boot proper raw from SPI NAND (copy A, else B), and
# U-Boot proper with the Mica FIT boot over UBI (mica-ubi-boot.c). The FIT host tools come from mainline U-Boot.
#
#   make uboot-mica   (--target artifact-mica)  loader.bin (flash.tsv's loader region), its config and the FIT
#                                               host tools
#
# ORCHESTRATION ONLY: build-mica.sh configures, builds and asserts. The steps shared with the other boards come
# in through the `bsp-scripts` build context (common/scripts) and the record parser through `mica-common`
# (common/uboot), as the board's Makefile wires them.

# The builder image is mica-build-env's bsp image, injected from locks/mica-build-env.lock by bin/mica-tools from:
# its amd64 variant carries the arm-linux-gnueabihf cross toolchain. No default: without a value docker refuses
# before any stage runs.
ARG MICA_BUILD_BSP
FROM --platform=$BUILDPLATFORM ${MICA_BUILD_BSP} AS source

# THE BUILD CLOCK, pinned: U-Boot reads SOURCE_DATE_EPOCH for its version banner. 1577836800 is
# 2020-01-01T00:00:00Z, the instant every artefact of this repository carries.
ENV SOURCE_DATE_EPOCH=1577836800

COPY --from=bsp-scripts . /bsp/scripts/
ARG UBOOT_REPO
ARG UBOOT_COMMIT
ARG UBOOT_GIT_NAME
ARG UBOOT_TOOLS_REPO
ARG UBOOT_TOOLS_COMMIT
ARG UBOOT_TOOLS_GIT_NAME
# The fetch-time mirror, tried before the pinned URL and skipped when it does not answer; not an input of this
# build (common/scripts/mirror.sh).
ARG MICA_MIRROR
RUN bash /bsp/scripts/fetch-source.sh --name "${UBOOT_GIT_NAME}" /uboot "${UBOOT_REPO}" "${UBOOT_COMMIT}"
RUN bash /bsp/scripts/fetch-source.sh --name "${UBOOT_TOOLS_GIT_NAME}" /uboot-tools "${UBOOT_TOOLS_REPO}" "${UBOOT_TOOLS_COMMIT}"

# ---- the third-party prefix ends here: the toolchain and the upstream source (common/scripts/buildx.sh).
FROM source AS build-mica
COPY build-mica.sh /bsp/uboot/
COPY mica-ubi-boot.c /uboot/common/
COPY --from=mica-common mica-records.h /uboot/common/
ARG BOOT_TRUST
ARG UBI_MTD
ARG FIT_UBI_ADDRESS
ARG FIT_UBI_LIMIT
RUN bash /bsp/uboot/build-mica.sh /uboot /uboot-tools "${BOOT_TRUST}" "${UBI_MTD}" "${FIT_UBI_ADDRESS}" "${FIT_UBI_LIMIT}"

FROM scratch AS artifact-mica
COPY --from=build-mica /uboot/loader.bin /
COPY --from=build-mica /uboot/mica.config /config
COPY --from=build-mica /uboot-tools/tools/mkimage /tools/mkimage
COPY --from=build-mica /uboot-tools/tools/fdt_add_pubkey /tools/fdt_add_pubkey
COPY --from=build-mica /uboot-tools/tools/fit_check_sign /tools/fit_check_sign
COPY --from=build-mica /uboot-tools/tools/dumpimage /tools/dumpimage
