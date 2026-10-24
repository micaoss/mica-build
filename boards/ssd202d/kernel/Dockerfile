# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# This board's kernel: its snapshot in micaoss/mica-linux, mainline stable for 32-bit Arm with the SSD20xD drivers
# and SoC device trees mainline lacks (carried from linux-chenxing) and the board's device tree, one commit each,
# configured by configure.sh (the defconfig, the composed floor and config/ssd202d.fragment, resolved to the
# recorded config/ssd202d.config) and compiled by build.sh, cross-built on the builder's platform with the bsp
# image's arm-linux-gnueabihf toolchain. The board's Makefile hands in:
#
#   KERNEL_SOURCE, KERNEL_VERSION, KERNEL_COMMIT   the board's git row of locks/upstream.lock
#   KERNEL_DEFCONFIG, KERNEL_EXPECT                bsp.env's: the base configuration and the release it reports
#   KERNEL_FEATURES                                board.env's, composed into the floor
#   KERNEL_CMDLINE                                 board.env's BOARD_CMDLINE_ARGS, the forced command line
#
#   make kernel          -> _out/ssd202d/kernel/{dev,prod}/{zImage,config,System.map,kernel.release,modules.tar,
#                           mstar-infinity2m-ssd202d-ybo-gw.dtb,mica-required.fragment}
#   make kernel-config   -> rewrites config/ssd202d.config from this build
#
# The board's device tree is compiled from the tree; it is the one the FIT carries (board.env FIT_DTB).
ARG MICA_BUILD_BSP

FROM --platform=$BUILDPLATFORM ${MICA_BUILD_BSP} AS src
ARG KERNEL_SOURCE
ARG KERNEL_VERSION
ARG KERNEL_COMMIT
ARG KERNEL_GIT_NAME
# MICA_MIRROR: the fetch-time mirror, tried before the pinned URL; not an input of this build.
ARG MICA_MIRROR
COPY --from=mica-scripts . /bsp/scripts/
RUN set -eu; \
    [ -n "${KERNEL_SOURCE}" ] && [ -n "${KERNEL_VERSION}" ] && [ -n "${KERNEL_COMMIT}" ] || { echo "error: the kernel needs KERNEL_SOURCE, KERNEL_VERSION and KERNEL_COMMIT (the board's Makefile reads them from locks/upstream.lock)" >&2; exit 1; }; \
    bash /bsp/scripts/fetch-source.sh --name "${KERNEL_GIT_NAME}" --tag "${KERNEL_VERSION}" /ksrc "${KERNEL_SOURCE}" "${KERNEL_COMMIT}"; \
    rm -rf /ksrc/.git /bsp/scripts

# THE CONFIGURATION, resolved and held to both fragments (configure.sh).
FROM src AS kconfig
ARG KERNEL_FEATURES
ARG KERNEL_CMDLINE
ARG KERNEL_DEFCONFIG
COPY --from=mica-common compose-floor.sh features.tsv /floor/
COPY --from=mica-common fragments/ /floor/fragments/
RUN [ -n "${KERNEL_FEATURES}" ] || { echo "error: KERNEL_FEATURES is empty; the board's Makefile passes board.env's" >&2; exit 1; }; \
    bash /floor/compose-floor.sh /floor "${KERNEL_FEATURES}" > /mica-required.fragment
COPY config/ssd202d.fragment /board.fragment
COPY --from=mica-trust signer.cert.pem /ksrc/certs/mica-verity-anchor.pem
RUN grep -q 'BEGIN CERTIFICATE' /ksrc/certs/mica-verity-anchor.pem || { echo "error: the mica-trust build context supplied no PEM certificate" >&2; exit 1; }
COPY configure.sh build.sh /bsp/build/kernel/
RUN [ -n "${KERNEL_DEFCONFIG}" ] || { echo "error: KERNEL_DEFCONFIG is empty; the board's Makefile passes bsp.env's" >&2; exit 1; }; \
    bash /bsp/build/kernel/configure.sh /ksrc "${KERNEL_DEFCONFIG}" /mica-required.fragment /board.fragment "${KERNEL_CMDLINE}" /board.config.resolved

# The export target for `make kernel-config`.
FROM scratch AS config
COPY --from=kconfig /board.config.resolved /ssd202d.config

# THE GATE: the resolved configuration is the recorded one.
FROM kconfig AS gate
COPY config/ssd202d.config /board.config.recorded
RUN diff -u /board.config.recorded /board.config.resolved >&2 || { echo "error: the resolved kernel config is not config/ssd202d.config; review the difference above and, if it is intended, run 'make ssd202d-kernel-config'" >&2; exit 1; }

# THE BUILD: one compile, both profiles (build.sh). The clock, the user and the host are pinned, so the image is
# one byte string per source.
FROM gate AS build
ENV KBUILD_BUILD_TIMESTAMP="@1577836800" \
    KBUILD_BUILD_USER=mica \
    KBUILD_BUILD_HOST=mica-build \
    KBUILD_BUILD_VERSION=1 \
    SOURCE_DATE_EPOCH=1577836800
COPY --from=mica-common set-profile.sh /bsp/set-profile.sh
ARG KERNEL_PROFILES="dev prod"
ARG KERNEL_EXPECT
RUN bash /bsp/build/kernel/build.sh /ksrc "${KERNEL_EXPECT}" "${KERNEL_PROFILES}" sigmastar/mstar-infinity2m-ssd202d-ybo-gw.dtb /mica-required.fragment /out

FROM scratch AS artifact
COPY --from=build /out/ /
