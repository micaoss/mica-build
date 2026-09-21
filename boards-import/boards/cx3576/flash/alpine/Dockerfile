# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# =============================================================================
# rootfs/alpine — Alpine 3.24.1 writable board-debug system
#
# Static target files live under rootfs/alpine/rootfs/ and are copied directly
# onto /. This Dockerfile only installs packages, creates debug accounts, adds
# kernel/firmware artifacts, registers OpenRC services, validates, and packs.
#
#   make rootfs -> out/rootfs/rootfs.img
# =============================================================================

# THE TWO BASE IMAGES, INJECTED FROM locks/mica-build-env.lock by
# tools/from.sh, which the board's Makefile calls. That is the one
# place answering "what does this repository build on"; a pin written beside
# its own FROM is a pin only that FROM's author reads.
#
# NO DEFAULTS. A pin written as an ARG
# DEFAULT is a pin any caller can silently replace, and a caller that forgets
# the argument builds against something else with no error at all. Without a
# default docker refuses before the first stage runs.
ARG MICA_IMAGE_ALPINE_3_24_1
ARG MICA_IMAGE_UBUNTU_2404
FROM ${MICA_IMAGE_ALPINE_3_24_1} AS rootfs

RUN apk add --no-cache \
        openrc busybox-openrc busybox-mdev-openrc \
        openssh sudo \
        docker docker-cli-compose \
        ifupdown-ng dhcpcd iproute2 iptables nftables \
        ca-certificates tzdata chrony \
        wpa_supplicant iw \
        dbus-openrc bluez bluez-openrc bluez-btmgmt \
        e2fsprogs-extra sgdisk parted cloud-utils-growpart \
        htop ethtool pciutils usbutils i2c-tools can-utils libdrm-tests

# The repository overlay mirrors the target Alpine root filesystem.
COPY rootfs/ /

# Lab-only accounts. Change both passwords immediately after first boot.
RUN echo 'root:root' | chpasswd && \
    adduser -D -s /bin/ash alpine && \
    echo 'alpine:alpine' | chpasswd && \
    adduser alpine wheel && \
    chmod 0440 /etc/sudoers.d/wheel && \
    visudo -cf /etc/sudoers

# Kernel modules must come from the same build as _out/kernel/Image. Named
# contexts support COPY, so extract the tarball in one explicit build step.
COPY --from=kernel-out modules.tar /tmp/modules.tar
RUN tar -xf /tmp/modules.tar -C / && rm /tmp/modules.tar

# Only the confirmed AIC8800D80 U02 runtime firmware enters the image.
COPY --from=firmware aic_userconfig_8800d80.txt \
     fw_adid_8800d80_u02.bin \
     fw_patch_8800d80_u02.bin \
     fw_patch_table_8800d80_u02.bin \
     fmacfw_8800d80_u02.bin \
     /lib/firmware/

# Runlevel links are generated against the exact OpenRC packages installed
# above; all service implementations and configuration live in the overlay.
RUN for service in devfs dmesg mdev hwdrivers; do rc-update add "$service" sysinit; done && \
    for service in modules sysctl hostname bootmisc cgroups machine-id seedrng \
                   syslog klogd wpa_supplicant networking resize-rootfs; do \
        rc-update add "$service" boot; \
    done && \
    for service in dbus usb-gadget-serial aic-bluetooth bluetooth chronyd crond \
                   sshd docker local status-led; do \
        rc-update add "$service" default; \
    done && \
    for service in killprocs mount-ro savecache; do rc-update add "$service" shutdown; done

# Fail the build when the overlay or package integration is incomplete.
RUN test -x /sbin/dhcpcd && \
    test -x /usr/local/bin/rs485-pair-test && \
    test -x /usr/local/bin/usb-gadget-serial && \
    test -x /usr/local/bin/usb-serial-getty && \
    test -x /usr/local/bin/bluetoothd-hostname && \
    test -x /etc/init.d/rk-board && \
    test -x /etc/init.d/usb-gadget-serial && \
    test -x /etc/init.d/aic-bluetooth && \
    test -x /etc/init.d/bluetooth && \
    test -x /etc/init.d/resize-rootfs && \
    test -x /etc/init.d/status-led && \
    grep -q '/dev/mmcblk0p3' /etc/init.d/resize-rootfs && \
    sh -n /usr/local/bin/rs485-pair-test && \
    sh -n /usr/local/bin/usb-gadget-serial && \
    sh -n /usr/local/bin/usb-serial-getty && \
    sh -n /usr/local/bin/bluetoothd-hostname && \
    sh -n /etc/init.d/rk-board && \
    sh -n /etc/init.d/usb-gadget-serial && \
    sh -n /etc/init.d/aic-bluetooth && \
    sh -n /etc/init.d/bluetooth && \
    sh -n /etc/init.d/resize-rootfs && \
    sh -n /etc/init.d/status-led && \
    test -e /etc/runlevels/boot/networking && \
    test -e /etc/runlevels/boot/wpa_supplicant && \
    test ! -e /etc/runlevels/boot/dhcpcd && \
    test -e /etc/runlevels/default/dbus && \
    test -e /etc/runlevels/default/usb-gadget-serial && \
    test -e /etc/runlevels/default/aic-bluetooth && \
    test -e /etc/runlevels/default/bluetooth && \
    test -e /etc/runlevels/default/status-led && \
    ifquery -i /etc/network/interfaces --list -a | grep -qx lo && \
    ifquery -i /etc/network/interfaces --list -a | grep -qx eth0 && \
    ifquery -i /etc/network/interfaces --list -a | grep -qx eth1 && \
    ifquery -i /etc/network/interfaces --list -a | grep -qx wlan0 && \
    ifquery -i /etc/network/interfaces --list -a | grep -qx can0 && \
    grep -q 'type can bitrate 250000 fd off' /etc/network/interfaces && \
    grep -qx 'rc_need="rk-board"' /etc/conf.d/wpa_supplicant && \
    grep -q 'need dbus localmount hostname aic-bluetooth' /etc/init.d/bluetooth && \
    grep -qxF '[General]' /etc/bluetooth/main.conf && \
    ! grep -q '^Name[[:space:]]*=' /etc/bluetooth/main.conf && \
    grep -qF 'bt_name=$(hostname)' /usr/local/bin/bluetoothd-hostname && \
    BLUEZ_RUNTIME_DIR=/tmp/bluez-test BLUETOOTHD=/bin/true \
        /usr/local/bin/bluetoothd-hostname && \
    grep -qx "Name = $(hostname)" /tmp/bluez-test/main.conf && \
    rm -rf /tmp/bluez-test && \
    grep -qx otg /etc/usb-otg-mode && \
    grep -qxF ttyFIQ0 /etc/securetty && \
    grep -qxF ttyGS0 /etc/securetty && \
    grep -q 'ttyGS0::respawn:/usr/local/bin/usb-serial-getty' /etc/inittab && \
    grep -q -- '-B /dev/ttyS4 -P h4 -S 1500000' /etc/init.d/aic-bluetooth && \
    grep -qx 'background' /etc/dhcpcd.conf && \
    grep -qx 'nohook resolv.conf, wpa_supplicant' /etc/dhcpcd.conf && \
    grep -qx 'Include /etc/ssh/sshd_config.d/\*.conf' /etc/ssh/sshd_config && \
    grep -qx 'PermitRootLogin yes' /etc/ssh/sshd_config.d/10-rk3576-debug.conf && \
    test -x /usr/bin/btmgmt

FROM --platform=$BUILDPLATFORM ${MICA_IMAGE_UBUNTU_2404} AS pack
RUN apt-get update && apt-get install -y --no-install-recommends e2fsprogs ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=rootfs / /rootfs/

# htop's desktop translations are unused on this headless debug image.
RUN rm -f /rootfs/usr/share/applications/htop.desktop && \
    grep -qx 'nameserver 1.1.1.1' /rootfs/etc/resolv.conf && \
    grep -qx 'nameserver 8.8.8.8' /rootfs/etc/resolv.conf && \
    (rg --hidden --no-messages -l -P \
        '[\x{3400}-\x{4dbf}\x{4e00}-\x{9fff}\x{f900}-\x{faff}]' \
        /rootfs > /tmp/rootfs-cjk-files || test "$?" -eq 1) && \
    test ! -s /tmp/rootfs-cjk-files || { \
        echo 'CJK text found in generated rootfs:' >&2; \
        cat /tmp/rootfs-cjk-files >&2; \
        exit 1; \
    } && \
    SZ=$(( $(du -sm /rootfs | cut -f1) * 13 / 10 + 64 )) && \
    mke2fs -q -t ext4 -L rootfs -d /rootfs \
        -O ^orphan_file,^metadata_csum_seed \
        -E root_owner=0:0 /rootfs.img "${SZ}M"

FROM scratch AS artifact
COPY --from=pack /rootfs.img /
