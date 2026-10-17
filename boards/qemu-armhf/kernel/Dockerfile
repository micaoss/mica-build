# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# This board's kernel: mainline stable for 32-bit Arm, configured here (multi_v7_defconfig, the composed floor and
# config/qemu-armhf.fragment, resolved to the recorded config/qemu-armhf.config), cross-built on the builder's
# platform with the bsp image's arm-linux-gnueabihf toolchain. The board's Makefile hands in:
#
#   KERNEL_SOURCE, KERNEL_VERSION, KERNEL_COMMIT   the board's git row of locks/upstream.lock
#   KERNEL_FEATURES                                its KERNEL_FEATURES, composed into the floor
#   KERNEL_CMDLINE                                 its BOARD_CMDLINE_ARGS, the forced command line
#
#   make kernel          -> _out/qemu-armhf/kernel/{dev,prod}/{zImage,config,System.map,kernel.release,modules.tar,
#                           qemu-virt.dtb,mica-required.fragment}
#   make kernel-config   -> rewrites config/qemu-armhf.config from this build
#
# The device tree is not built: it is QEMU's own (dts/qemu-virt.dtb, recorded by dts/dump.sh), the one the FIT
# carries.
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

# THE CONFIGURATION, resolved: the defconfig is the base, the floor and the board's fragment the delta, and the
# forced command line the board's.
FROM src AS kconfig
ARG KERNEL_FEATURES
ARG KERNEL_CMDLINE
COPY --from=mica-common compose-floor.sh features.tsv /floor/
COPY --from=mica-common fragments/ /floor/fragments/
RUN [ -n "${KERNEL_FEATURES}" ] || { echo "error: KERNEL_FEATURES is empty; the board's Makefile passes its KERNEL_FEATURES" >&2; exit 1; }; \
    bash /floor/compose-floor.sh /floor "${KERNEL_FEATURES}" > /mica-required.fragment
COPY config/qemu-armhf.fragment /board.fragment
COPY --from=mica-trust signer.cert.pem /ksrc/certs/mica-verity-anchor.pem
RUN grep -q 'BEGIN CERTIFICATE' /ksrc/certs/mica-verity-anchor.pem || { echo "error: the mica-trust build context supplied no PEM certificate" >&2; exit 1; }
RUN set -eu; cd /ksrc; mk() { make ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- "$@"; }; \
    [ -n "${KERNEL_CMDLINE}" ] || { echo "error: KERNEL_CMDLINE is empty; the board's Makefile passes its BOARD_CMDLINE_ARGS" >&2; exit 1; }; \
    mk multi_v7_defconfig; \
    ARCH=arm scripts/kconfig/merge_config.sh -m .config /mica-required.fragment /board.fragment; \
    scripts/config --set-str CMDLINE "${KERNEL_CMDLINE}"; \
    mk olddefconfig; \
    grep -E '^(CONFIG_[A-Za-z0-9_]+=|# CONFIG_[A-Za-z0-9_]+ is not set$)' .config \
      | grep -vE '^CONFIG_(CC_VERSION_TEXT|GCC_VERSION|AS_VERSION|LD_VERSION|LLD_VERSION|CLANG_VERSION|PAHOLE_VERSION|RUSTC_VERSION|RUSTC_LLVM_VERSION)=' \
      > /board.config.resolved

# The export target for `make kernel-config`.
FROM scratch AS config
COPY --from=kconfig /board.config.resolved /qemu-armhf.config

# THE GATE: the resolved configuration is the recorded one, every =y line of both fragments survived and every
# option they record off is off, and the LSM list and the trust anchor are the floor's.
FROM kconfig AS gate
COPY config/qemu-armhf.config /board.config.recorded
RUN set -eu; cd /ksrc; \
    diff -u /board.config.recorded /board.config.resolved >&2 || { echo "error: the resolved kernel config is not config/qemu-armhf.config; review the difference above and, if it is intended, run 'make -C boards/qemu-armhf kernel-config'" >&2; exit 1; }; \
    for line in $(sed -n 's/^\(CONFIG_[A-Z0-9_]*=y\)$/\1/p' /mica-required.fragment /board.fragment); do \
        grep -qx "${line}" .config || { echo "error: missing required option ${line}" >&2; exit 1; }; done; \
    for sym in $(sed -n 's/^# \(CONFIG_[A-Z0-9_]*\) is not set$/\1/p' /mica-required.fragment /board.fragment); do \
        ! grep -q "^${sym}=" .config || { echo "error: ${sym} is recorded off and is on" >&2; exit 1; }; done; \
    grep -qx "$(grep '^CONFIG_LSM=' /mica-required.fragment)" .config; \
    grep -qx "$(grep '^CONFIG_SYSTEM_TRUSTED_KEYS=' /mica-required.fragment)" .config; \
    echo "config: the recorded config holds the floor and the board's fragment"

# THE BUILD: one compile, both profiles. The first profile is built whole; prod only moves the forced command
# line (common/kernel/set-profile.sh) and relinks. The clock, the user and the host are pinned, so the image is
# one byte string per source.
FROM gate AS build
ENV KBUILD_BUILD_TIMESTAMP="@1577836800" \
    KBUILD_BUILD_USER=mica \
    KBUILD_BUILD_HOST=mica-build \
    KBUILD_BUILD_VERSION=1 \
    SOURCE_DATE_EPOCH=1577836800
COPY --from=mica-common set-profile.sh /bsp/set-profile.sh
COPY dts/qemu-virt.dtb /qemu-virt.dtb
ARG KERNEL_PROFILES="dev prod"
RUN set -eu; cd /ksrc; mk() { make ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- "$@"; }; first=""; \
    for profile in ${KERNEL_PROFILES}; do \
        bash /bsp/set-profile.sh /ksrc "${profile}" ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-; \
        if [ -z "${first}" ]; then \
            mk -j"$(nproc)" zImage modules; \
            rm -rf /kmods; mk INSTALL_MOD_PATH=/kmods INSTALL_MOD_STRIP=1 modules_install; \
            release="$(cat include/config/kernel.release)"; \
            [ -f "/kmods/lib/modules/${release}/modules.builtin" ] && [ -f "/kmods/lib/modules/${release}/modules.dep" ] || { echo "error: modules_install wrote no index for ${release}" >&2; exit 1; }; \
            rm -f "/kmods/lib/modules/${release}/build" "/kmods/lib/modules/${release}/source"; \
            tar --sort=name --mtime=@1577836800 --owner=0 --group=0 --numeric-owner -C /kmods -cf /modules.tar lib; \
            printf '%s\n' "${release}" > /kernel.release; \
            first="${profile}"; \
        else \
            mk -j"$(nproc)" zImage; \
        fi; \
        for option in DM_INIT DM_VERITY SQUASHFS MTD_UBI MTD_UBI_BLOCK UBIFS_FS I6300ESB_WDT CMDLINE_FORCE; do \
            grep -q "^CONFIG_${option}=y" include/config/auto.conf || { echo "error: CONFIG_${option} is not =y in the compiled tree" >&2; exit 1; }; done; \
        out="/out/${profile}"; mkdir -p "${out}"; \
        cp arch/arm/boot/zImage System.map /kernel.release /modules.tar /qemu-virt.dtb /mica-required.fragment "${out}/"; \
        cp .config "${out}/config"; \
        echo "kernel ${profile}: zImage $(stat -c%s arch/arm/boot/zImage) bytes"; \
    done; \
    [ -n "${first}" ] || { echo "error: KERNEL_PROFILES names no profile" >&2; exit 1; }

FROM scratch AS artifact
COPY --from=build /out/ /
