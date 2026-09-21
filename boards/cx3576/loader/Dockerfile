# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Build U-Boot v2026.07 with RK3576 DDR v1.12 and BL31 v1.24.
# Recovery enters RockUSB; failed boot falls back to RockUSB.
#
# Two targets:
#   make uboot      (default artifact)      debug variant, ENV_IS_NOWHERE
#   make uboot-mica  (--target artifact-mica) fixed signed FIT file boot with
#     bounded redundant counters and an explicit public boot certificate.
#
# ORCHESTRATION ONLY. build.sh configures and builds the debug variant, and
# build-mica.sh reconfigures that tree for the A/B variant; both carry their own
# assertions. The steps this shares with the kernel builder come in through the
# `bsp-scripts` build context, which the board's Makefile wires to
# common/scripts — the same shape the kernel Dockerfile uses for mica-common, and the
# reason this target's context can stay `loader` rather than widening to the whole
# board directory. RFCT-345 moved all of it out of here and gated the move on the
# eleven BSP artefacts coming back byte-identical.

# The builder image is injected from locks/mica-build-env.lock by
# tools/from.sh, which the board's Makefile calls. A bare tag like
# `ubuntu:24.04` is one Canonical repoints on every point release, so the answer
# to "which toolchain produced this artefact" would be the date of the build.
# Ubuntu and not mica-build-c: the BSP builders get digest pins only, because
# this cross-compiles a vendor tree against gcc-aarch64-linux-gnu,
# python3-pyelftools, swig and device-tree-compiler at the versions that tree
# was tested with, and mica-build-c would be a BSP rebuilt under a toolchain
# nobody has booted on the hardware. There is no default: without a value docker
# refuses before any stage runs, where a default would build green against an
# image nobody chose.
ARG MICA_BUILD_BSP
FROM --platform=$BUILDPLATFORM ${MICA_BUILD_BSP} AS source

# THE BUILD CLOCK, pinned. Measured under RFCT-343: this Dockerfile pinned none
# of SOURCE_DATE_EPOCH or KBUILD_BUILD_*, and both variants shipped their own
# wall clock in the version banner --
#   U-Boot 2026.07-gece349ade297-dirty (Aug 25 2026 - 18:35:45 +0000)   uboot
#   U-Boot 2026.07-gece349ade297-dirty (Aug 30 2026 - 16:29:48 +0000)   uboot-mica
# read straight out of the shipped binaries. Two builds of one unchanged tree
# therefore differed, `uname -v`-style, and no comparison of a boot blob against
# its source could be a byte comparison.
#
# U-Boot reads SOURCE_DATE_EPOCH for exactly this (docs.u-boot.org, "Reproducible
# builds"): it replaces the timestamp in the banner and in the FIT it builds.
# 1577836800 is 2020-01-01T00:00:00Z, the same constant board.env
# pins as FILE_MTIME and E2FSPROGS_FAKE_TIME, rootfs/build.sh passes as
# SOURCE_DATE_EPOCH and kernel/Dockerfile now pins too. One instant across every
# artefact this repository produces.
#
# `-dirty` stays and is not a defect: the patch series is applied to the fetched
# tree without committing, so `git describe` says dirty on every build. It is
# the same word every time, which is all reproducibility asks of it.
ENV SOURCE_DATE_EPOCH=1577836800

COPY --from=bsp-scripts . /bsp/scripts/

# The package LIST stays here rather than in a file: it is what this builder is,
# and it belongs beside the FROM that says which image it is installed into.
# The toolchain is the bsp image of mica-build-env, pinned by digest: native on
# an arm64 builder, cross on amd64 (its amd64 variant carries the aarch64 cross
# packages). The host tools this build ships (mkimage, fdt_add_pubkey,
# fit_check_sign, dumpimage) are binaries of the builder's architecture.
ARG BUILDARCH

ARG RKBIN_REPO
ARG RKBIN_COMMIT
ARG RKBIN_GIT_NAME
# The fetch-time mirror, tried before the pinned URL and skipped when it does
# not answer; not an input of this build (common/scripts/mirror.sh).
ARG MICA_MIRROR
RUN bash /bsp/scripts/fetch-source.sh --name "${RKBIN_GIT_NAME}" /rkbin "${RKBIN_REPO}" "${RKBIN_COMMIT}"

ARG UBOOT_REPO
ARG UBOOT_COMMIT
ARG UBOOT_GIT_NAME
RUN bash /bsp/scripts/fetch-source.sh --name "${UBOOT_GIT_NAME}" /uboot "${UBOOT_REPO}" "${UBOOT_COMMIT}"

# ---- the third-party prefix ends here: the toolchain and the upstream source,
# nothing of this repository's (the only stage a CI cache holds; see
# common/scripts/buildx.sh). The build continues on it with the
# same build arguments.
FROM source AS build
ARG DEBIAN_FRONTEND=noninteractive
ARG RKBIN_REPO
ARG RKBIN_COMMIT
ARG UBOOT_REPO
ARG UBOOT_COMMIT

COPY patches/ /patches/
RUN bash /bsp/scripts/apply-patches.sh /uboot /patches git

ARG DDR_BLOB
ARG BL31_BLOB
ARG UBOOT_DEFCONFIG
COPY build.sh /bsp/uboot/build.sh
RUN bash /bsp/uboot/build.sh /uboot /rkbin "${DDR_BLOB}" "${BL31_BLOB}" "${UBOOT_DEFCONFIG}"

FROM build AS build-mica
ARG DDR_BLOB
ARG BL31_BLOB
COPY build-mica.sh /bsp/uboot/
COPY --from=mica-common embed-fit-trust.sh /bsp/uboot/embed-trust.sh
COPY tests/ /bsp/uboot/tests/
COPY mica-file-boot.c /uboot/common/
COPY --from=mica-common mica-records.h /uboot/common/
COPY --from=mica-boot-trust signer.cert.pem /mica-boot-trust.crt
RUN bash /bsp/uboot/build-mica.sh /uboot /rkbin "${DDR_BLOB}" "${BL31_BLOB}" /mica-boot-trust.crt

FROM scratch AS artifact-mica
COPY --from=build-mica /uboot/u-boot-rockchip.bin /
COPY --from=build-mica /uboot/spl/u-boot-spl.bin /
COPY --from=build-mica /uboot/u-boot.itb /
COPY --from=build-mica /uboot/u-boot.dtb /
COPY --from=build-mica /uboot/mica.config /config
COPY --from=build-mica /uboot/tools/mkimage /tools/mkimage
COPY --from=build-mica /uboot/tools/fdt_add_pubkey /tools/fdt_add_pubkey
COPY --from=build-mica /uboot/tools/fit_check_sign /tools/fit_check_sign
COPY --from=build-mica /uboot/tools/dumpimage /tools/dumpimage

FROM scratch AS artifact
COPY --from=build /uboot/u-boot-rockchip.bin /
COPY --from=build /uboot/spl/u-boot-spl.bin /
COPY --from=build /uboot/u-boot.itb /
