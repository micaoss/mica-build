# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# The cx3576 kernel: the Rockchip vendor tree at its git row in locks/upstream.lock, the
# board's configuration, device tree and patches, and the board's hooks.
#
# ORCHESTRATION ONLY. Every step is a file: common/scripts/ for what
# the kernel and U-Boot builders share, kernel/configure.sh for the resolved
# configuration and its floor, kernel/build.sh for the compile and packaging,
# and under kernel/: config/, dts/, patches/ (with a series
# file) and hooks/ -- prepare.sh (after the patches, before the
# configuration), configure.sh (the board's kconfig edits, before the floor is
# merged), assert.sh (over the resolved configuration) and verify.sh (over the
# built tree and the device tree). Every hook is optional; a board with none
# builds the plain vendor kernel. The BUILD CONTEXT is the board's
# directory; the shared scripts arrive through the named context `common`, the
# shared kernel floor through `mica-common`, the verity anchor through
# `mica-trust` -- all wired by the board's Makefile, so a bare build
# without them fails at the COPY rather than building against nothing.

# Digest-pinned from locks/mica-build-env.lock via tools/from.sh. Ubuntu rather
# than mica-build-c: this cross-compiles a vendor tree against the toolchain
# versions that tree was tested with. No default, so a build without the
# value is refused rather than built against an image nobody chose.
ARG MICA_BUILD_BSP
FROM --platform=$BUILDPLATFORM ${MICA_BUILD_BSP} AS source

COPY --from=common scripts/ /bsp/scripts/

# The toolchain is the bsp image of mica-build-env, pinned by digest in
# locks/mica-build-env.lock: it carries the kernel build dependencies and, on
# its amd64 variant, the aarch64 cross packages. On an arm64 builder (the native
# CI runner) the build is native -- that image's gcc already answers to
# aarch64-linux-gnu-*. Nothing is installed here.
ARG BUILDARCH

ARG KERNEL_REPO
ARG KERNEL_COMMIT
ARG KERNEL_GIT_NAME
# The fetch-time mirror, tried before the pinned URL and skipped when it does
# not answer; not an input of this build (common/scripts/mirror.sh).
ARG MICA_MIRROR
RUN bash /bsp/scripts/fetch-source.sh --name "${KERNEL_GIT_NAME}" /ksrc "${KERNEL_REPO}" "${KERNEL_COMMIT}"

# ---- the third-party prefix ends here: the toolchain and the upstream source,
# nothing of this repository's (the only stage a CI cache holds; see
# common/scripts/buildx.sh). The build continues on it with the
# same build arguments.
FROM source AS build
ARG DEBIAN_FRONTEND=noninteractive
ARG KERNEL_REPO
ARG KERNEL_COMMIT

# The board's .dts files land beside the patches so the tree is coherent from
# the moment a patch registers them in the rockchip dts Makefile.
COPY kernel/patches/ /patches/
COPY kernel/dts/ /ksrc/arch/arm64/boot/dts/rockchip/
RUN bash /bsp/scripts/apply-patches.sh /ksrc /patches patch

# The board's own inputs and the family's tools, then the prepare hook: what
# a board derives into the source tree before configuration (cx3576 renders
# its boot logo from the committed master here, with
# common/kernel/mklogo.py, rather than committing a 2.2 MB PPM).
COPY . /bsp/board/
COPY --from=common kernel/ /bsp/common/kernel/
COPY kernel/configure.sh kernel/build.sh /bsp/build/kernel/
RUN [ ! -f /bsp/board/kernel/hooks/prepare.sh ] || \
        bash /bsp/board/kernel/hooks/prepare.sh /ksrc /bsp/board /bsp/common/kernel

# Needs the named build contexts: `mica-common` for the shared floor and
# `mica-trust` for the verity content anchor -- the file
# common/kernel/mica-required.fragment names in CONFIG_SYSTEM_TRUSTED_KEYS, which
# certs/Makefile resolves against the source tree. Public material only: an
# X.509 certificate goes in; the private half stays with the assembly.
ARG KERNEL_CONFIG
COPY kernel/config/${KERNEL_CONFIG} /ksrc/.config
COPY --from=mica-common mica-required.fragment /mica-required.fragment
COPY --from=mica-trust signer.cert.pem /ksrc/certs/mica-verity-anchor.pem
RUN bash /bsp/build/kernel/configure.sh /ksrc /mica-required.fragment /bsp/board/kernel/hooks

# FOUR PINS, AND ALL FOUR ARE LOAD-BEARING. The first three are what Kbuild
# stamps into the image; without them it carries the wall clock and
# `root@buildkitsandbox`. SOURCE_DATE_EPOCH is not redundant with them: Kbuild
# never reads it, but gcc honours it for `__DATE__` and `__TIME__`, which the
# vendor Mali driver compiles in and which no KBUILD_BUILD_* can reach. A
# fifth thing is needed and is not here: `BUILD_DATE=$(shell date)` in the
# Mali Kbuild is a make-time shell call no environment variable reaches,
# pinned by a board patch. 1577836800 is 2020-01-01T00:00:00Z, the instant
# board.env pins as FILE_MTIME and the composer passes as SOURCE_DATE_EPOCH.
# Stays below configure.sh and above build.sh: nothing in the configuration
# step reads a clock, and every artefact these values stabilise is produced
# below.
# KBUILD_BUILD_VERSION: the `#1` in the version string, which Kbuild otherwise
# counts up with every link of one tree -- the prod image below is the tree's
# second link.
ENV KBUILD_BUILD_TIMESTAMP="@1577836800" \
    KBUILD_BUILD_USER=mica \
    KBUILD_BUILD_HOST=mica-build \
    KBUILD_BUILD_VERSION=1 \
    SOURCE_DATE_EPOCH=1577836800

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
COPY --from=mica-common export-regdb-certs.py /bsp/kernel/export-regdb-certs.py
RUN set -eu; first=""; \
    for profile in ${KERNEL_PROFILES}; do \
        bash /bsp/common/kernel/set-profile.sh /ksrc "${profile}" ARCH=arm64 CROSS_COMPILE=aarch64-linux-gnu-; \
        if [ -z "${first}" ]; then \
            bash /bsp/build/kernel/build.sh /ksrc "${KERNEL_EXPECT}" "${KERNEL_DTB}" "/${KERNEL_DTB_ARTIFACT}" /bsp/board/kernel/hooks; \
            python3 /bsp/kernel/export-regdb-certs.py /ksrc /regdb-certs.pem; \
            first="${profile}"; \
        else \
            bash /bsp/build/kernel/build.sh --image /ksrc "${KERNEL_EXPECT}"; \
        fi; \
        out="/out/${profile}"; mkdir -p "${out}"; \
        cp /ksrc/arch/arm64/boot/Image /ksrc/System.map /kernel.release /modules.tar "/${KERNEL_DTB_ARTIFACT}" /regdb-certs.pem "${out}/"; \
        cp /ksrc/.config "${out}/config"; \
        cp /mica-required.fragment "${out}/mica-required.fragment"; \
    done; \
    [ -n "${first}" ] || { echo "error: KERNEL_PROFILES names no profile" >&2; exit 1; }

# THE RESOLVED CONFIG IS AN ARTIFACT: what olddefconfig decided over the board
# config merged with the common fragment, the only form of the `=y` floor the
# image contract can read back out of a packed root; kernel.release names it
# downstream so it and the modules beside it cannot come from different
# kernels unnoticed. SYSTEM.MAP IS PART OF THAT PROVENANCE: 6.5 MiB of text
# beside a 42 MiB Image, and what makes a register dump readable without the
# board in front of you (RFCT-351). NOT vmlinux (173 MiB with DEBUG_INFO=y);
# it stays in the build stage. The bundle producer stages named files, so a
# new file here reaches the bundle only when it is named there.
#
# AND THE FLOOR TRAVELS WITH IT. mica-build asserts the shared floor against
# the config of the board bundle it fetched at its pin
# (build/src/kernel-package.ts), and it must not keep a copy of the symbol
# list: a private copy of another repository's truth drifts the first time the
# fragment moves. The fragment that resolved this config ships beside it, so
# both ends of that assertion are one fetched artifact and a stale bundle
# fails its own floor instead of passing quietly.
FROM scratch AS artifact
COPY --from=build /out/ /
