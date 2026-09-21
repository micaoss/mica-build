# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# The s905x5m kernel: the Hardkernel vendor tree at its git row in locks/upstream.lock, the board's configuration and fragments, device tree and patches, and
# the board's hooks -- prepare.sh, configure.sh, assert.sh, modules.sh (the
# board's out-of-tree modules, built against the compiled tree before depmod)
# and verify.sh. Every hook is optional. The BUILD CONTEXT is the board's
# directory; the shared scripts arrive through the named context `common`,
# the shared floor through `mica-common`, the verity anchor through
# `mica-trust`, all wired by the board's Makefile.

# The builder image is injected from locks/mica-build-env.lock by the board's Makefile.
# There is no default: an omitted pin must fail before the build can
# silently choose a mutable tag.
ARG MICA_BUILD_BSP
FROM --platform=$BUILDPLATFORM ${MICA_BUILD_BSP} AS source

ARG DEBIAN_FRONTEND=noninteractive
COPY --from=common scripts/ /bsp/scripts/

# Fetch the source before anything else. It is by far the slowest step -- the
# submodules come from git.odroid.com, which has stalled for minutes at a time
# -- and it depends only on KERNEL_REPO/KERNEL_COMMIT. Keeping it ahead of the
# package list and the config means editing either of those reuses the cached
# source instead of cloning several GB again. HTTP/1.1, because git over
# HTTP/2 stalls against this host (fetch-source.sh --http1).
ARG KERNEL_REPO
ARG KERNEL_COMMIT
ARG KERNEL_GIT_NAME
# The fetch-time mirror, tried before the pinned URL and skipped when it does
# not answer; not an input of this build (common/scripts/mirror.sh).
ARG MICA_MIRROR
RUN bash /bsp/scripts/fetch-source.sh --http1 --submodules --name "${KERNEL_GIT_NAME}" /ksrc "${KERNEL_REPO}" "${KERNEL_COMMIT}"

# On an arm64 builder the kernel is a native build (the bsp image's gcc answers
# to aarch64-linux-gnu-* there); its amd64 variant carries the cross packages.
ARG BUILDARCH
ARG CROSS_COMPILE_amd64=aarch64-linux-gnu-
ARG CROSS_COMPILE_arm64=

# ---- the third-party prefix ends here: the toolchain and the upstream source,
# nothing of this repository's (the only stage a CI cache holds; see
# common/scripts/buildx.sh). The build continues on it with the
# same build arguments.
FROM source AS build
ARG DEBIAN_FRONTEND=noninteractive
ARG KERNEL_REPO
ARG KERNEL_COMMIT
ARG BUILDARCH
ARG CROSS_COMPILE_amd64=aarch64-linux-gnu-
ARG CROSS_COMPILE_arm64=

COPY kernel/patches/ /patches/
RUN bash /bsp/scripts/apply-patches.sh /ksrc /patches patch

# The board's own inputs and the family's tools, then the prepare hook.
COPY . /bsp/board/
COPY --from=common kernel/ /bsp/common/kernel/
COPY kernel/configure.sh kernel/build.sh /bsp/build/kernel/
COPY kernel/dts/ /ksrc/common_drivers/arch/arm64/boot/dts/amlogic/
RUN [ ! -f /bsp/board/kernel/hooks/prepare.sh ] || \
        bash /bsp/board/kernel/hooks/prepare.sh /ksrc /bsp/board /bsp/common/kernel

ARG KERNEL_CONFIG
ARG KERNEL_FRAGMENTS
COPY kernel/config/${KERNEL_CONFIG} /ksrc/.config
COPY kernel/config/ /bsp/board/kernel/config/
COPY --from=mica-common mica-required.fragment /mica-required.fragment
COPY --from=mica-trust signer.cert.pem /ksrc/certs/mica-verity-anchor.pem
RUN eval "export CROSS_COMPILE=\$CROSS_COMPILE_${BUILDARCH}"; \
    bash /bsp/build/kernel/configure.sh /ksrc /mica-required.fragment /bsp/board/kernel/config "${KERNEL_FRAGMENTS}" /bsp/board/kernel/hooks

# KBUILD_BUILD_VERSION: the `#1` in the version string, which Kbuild otherwise
# counts up with every link of one tree -- the prod image below is its second.
ENV KBUILD_BUILD_TIMESTAMP="@1577836800" KBUILD_BUILD_USER=mica KBUILD_BUILD_HOST=mica-build KBUILD_BUILD_VERSION=1 SOURCE_DATE_EPOCH=1577836800

# ONE COMPILE, BOTH PROFILES. The first profile is built whole; every further
# one only moves the forced command line (common/kernel/set-profile.sh) and
# relinks the Image in the same tree, taking the modules, the device tree and
# the regulatory certificates of the first build, which do not read the
# command line. KERNEL_PROFILES=prod alone is a clean prod build, what
# `make kernel-profile-test` compares the relinked one with.
ARG KERNEL_EXPECT
ARG KERNEL_DTB
ARG KERNEL_DTB_ARTIFACT
ARG KERNEL_PROFILES="dev prod"
COPY --from=mica-common export-regdb-certs.py /export-regdb-certs.py
RUN set -eu; eval "export CROSS_COMPILE=\$CROSS_COMPILE_${BUILDARCH}"; first=""; \
    for profile in ${KERNEL_PROFILES}; do \
        bash /bsp/common/kernel/set-profile.sh /ksrc "${profile}" ARCH=arm64 CROSS_COMPILE="${CROSS_COMPILE}"; \
        if [ -z "${first}" ]; then \
            bash /bsp/build/kernel/build.sh /ksrc "${KERNEL_EXPECT}" "${KERNEL_DTB}" "/${KERNEL_DTB_ARTIFACT}" /bsp/board /bsp/board/kernel/hooks; \
            python3 /export-regdb-certs.py /ksrc /regdb-certs.pem; \
            first="${profile}"; \
        else \
            bash /bsp/build/kernel/build.sh --image /ksrc "${KERNEL_EXPECT}"; \
        fi; \
        out="/out/${profile}"; mkdir -p "${out}"; \
        cp /ksrc/arch/arm64/boot/Image /ksrc/System.map /ksrc/include/config/kernel.release /modules.tar "/${KERNEL_DTB_ARTIFACT}" /regdb-certs.pem "${out}/"; \
        cp /ksrc/.config "${out}/config"; \
        cp /mica-required.fragment "${out}/mica-required.fragment"; \
    done; \
    [ -n "${first}" ] || { echo "error: KERNEL_PROFILES names no profile" >&2; exit 1; }

# THE FLOOR TRAVELS WITH THE CONFIG IT PRODUCED. mica-build asserts the shared
# floor against the config of the board bundle it fetched at its pin
# (build/src/kernel-package.ts), and it must not keep a copy of the symbol
# list: a private copy of another repository's truth drifts the first time the
# fragment moves. The fragment that resolved each profile's config ships beside
# it, so both ends of that assertion are one fetched artifact and a stale
# bundle fails its own floor instead of passing quietly.
FROM scratch AS artifact
COPY --from=build /out/ /
