# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# Build the glibc-linked Seekwave Bluetooth bridge used by the Mica OS rootfs.
# The sources are the minimal runtime set imported from s905x5m-alpine commit
# 49618bed07508b77bb8e8e640e0faafc5c95ea9a.

# The toolchain is the mica-build-env c image (Debian trixie's build-essential,
# the glibc of the Base root), pinned by digest in locks/mica-build-env.lock:
# no package is installed here, so the compiler cannot move under the
# mica-s905x5m-bluetooth version without the lock moving.
ARG MICA_BUILD_C
FROM --platform=$TARGETPLATFORM ${MICA_BUILD_C} AS build
ARG TARGETARCH
RUN test "$TARGETARCH" = arm64
# The image puts ccache in front of gcc; this build compiles without it.
ENV CCACHE_DISABLE=1

COPY versions.env /build/versions.env
COPY skwbt /build/skwbt
COPY skw_bridge /build/skw_bridge

# The library's Android default points into /vendor. The bridge address file
# belongs under the STATE-backed /var/lib/bluetooth mount because the root is
# read-only and every board needs a stable, per-device controller address.
RUN set -eu; \
    . /build/versions.env; \
    skw_cc="gcc -Werror -DSKW_BRIDGE_VERSION='\"$SKW_BRIDGE_VERSION\"' \
        -DSKWBT_CONFIG_FILE='\"/etc/bluetooth/skwbt.conf\"' \
        -DSKWBT_BDADDR_FILE='\"/var/lib/bluetooth/bdaddr\"'"; \
    make -C /build/skwbt clean; \
    make -C /build/skwbt unit-test HOSTCC=gcc; \
    make -C /build/skwbt CC="$skw_cc" AR=ar STRIP=strip; \
    test -s /build/skwbt/build/libskwbt.so; \
    ! nm -D /build/skwbt/build/libskwbt.so \
        | grep -Eq 'skw_addr_|skw_ext_|scomm_vendor_config|wakeup_ADV'; \
    ln -s /build/skwbt/include /build/skw_bridge/include; \
    make -C /build/skw_bridge -f Makefile.vhci clean; \
    make -C /build/skw_bridge -f Makefile.vhci unit-test HOSTCC=gcc; \
    make -C /build/skw_bridge -f Makefile.vhci CC="$skw_cc" AR=ar STRIP=strip; \
    test -s /build/skw_bridge/build/skw_vhci_bridge; \
    /build/skw_bridge/build/skw_vhci_bridge --version | grep -qx "skw_vhci_bridge $SKW_BRIDGE_VERSION"; \
    strip --strip-unneeded /build/skwbt/build/libskwbt.so; \
    strip --strip-unneeded /build/skw_bridge/build/skw_vhci_bridge; \
    install -D -m 0755 /build/skwbt/build/libskwbt.so \
        /artifact/usr/lib/bluetooth/plugins/libskwbt.so; \
    install -D -m 0755 /build/skw_bridge/build/skw_vhci_bridge \
        /artifact/usr/sbin/skw_vhci_bridge; \
    for f in skwbt.conf sv6160.nvbin sv6160lite.nvbin sv6316.nvbin; do \
        install -D -m 0644 "/build/skwbt/bluetooth_conf/$f" "/artifact/etc/bluetooth/$f"; \
    done; \
    readelf -h /artifact/usr/sbin/skw_vhci_bridge | grep -q 'Machine:.*AArch64'; \
    readelf -h /artifact/usr/lib/bluetooth/plugins/libskwbt.so | grep -q 'Machine:.*AArch64'; \
    strings /artifact/usr/sbin/skw_vhci_bridge \
        | grep -qx '/var/lib/bluetooth/bdaddr'; \
    ! strings /artifact/usr/lib/bluetooth/plugins/libskwbt.so \
        | grep -q '^/vendor/etc/bluetooth'; \
    strings /artifact/usr/lib/bluetooth/plugins/libskwbt.so \
        | grep -q '^/etc/bluetooth'

FROM scratch AS artifact
COPY --from=build /artifact/ /
