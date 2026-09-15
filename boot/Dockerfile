# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# The boot packager: ukify, sbsign/sbverify, objcopy, the systemd-boot-efi UKI
# stub, cpio and zstd from the one archive the apt row of locks/mica-system-base.lock names, and the
# unsigned systemd-boot loader of the Base pool's mica-systemd-boot, which
# kernel.sh `firmware` signs. Nothing is compiled here.
ARG MICA_IMAGE_DEBIAN_TRIXIE
FROM ${MICA_IMAGE_DEBIAN_TRIXIE} AS tools
ARG MICA_BOOT_TARGET=x64
ARG MICA_DEBIAN_SNAPSHOT
RUN case "$MICA_BOOT_TARGET" in x64|aa64) ;; *) echo 'invalid boot-tools target' >&2; exit 64 ;; esac; \
    rm -f /etc/apt/sources.list.d/debian.sources && \
    printf 'deb [check-valid-until=no] %s trixie main\n' "${MICA_DEBIAN_SNAPSHOT}" > /etc/apt/sources.list.d/snapshot.list && \
    apt-get -o Acquire::Retries=3 update -qq && \
    apt-get install -y --no-install-recommends \
        cryptsetup-bin dmsetup util-linux mount cpio file binutils zstd \
        systemd systemd-boot-efi systemd-ukify sbsigntool squashfs-tools && \
    rm -rf /var/lib/apt/lists/*
RUN if [ "$MICA_BOOT_TARGET" = aa64 ]; then \
    dpkg --add-architecture arm64 && apt-get update -qq && \
    apt-get install -y --no-install-recommends binutils-aarch64-linux-gnu && \
    mkdir -p /arm-debs/partial /arm64 && \
    apt-get -o APT::Architecture=arm64 -o APT::Architectures::=arm64 \
        -o Dir::State::status=/dev/null -o Dir::Cache::archives=/arm-debs \
        --download-only -y --no-install-recommends install \
        systemd-boot-efi:arm64 && \
    for archive in /arm-debs/*.deb; do dpkg-deb -x "$archive" /arm64; done && \
    rm -rf /arm-debs /var/lib/apt/lists/*; \
    fi
COPY initramfs.sh kernel.sh compression.sh elf-closure.py /tools/

FROM tools AS artifact-tools
LABEL mica.boot.target=${MICA_BOOT_TARGET}
# The loader archive, fetched and verified at its pin by tools/pool.sh.
RUN --mount=type=bind,from=loader,target=/loader \
    set -eu; \
    test "$(dpkg-deb -f /loader/mica-systemd-boot.deb Package)" = mica-systemd-boot; \
    dpkg-deb -x /loader/mica-systemd-boot.deb /loader-pkg; \
    mkdir -p /usr/lib/systemd/boot/efi /usr/share/doc/mica-systemd-boot; \
    install -m 0644 "/loader-pkg/usr/lib/mica/systemd-boot/systemd-boot${MICA_BOOT_TARGET}.efi" /usr/lib/systemd/boot/efi/; \
    install -m 0644 /loader-pkg/usr/share/doc/mica-systemd-boot/copyright /usr/share/doc/mica-systemd-boot/copyright; \
    rm -rf /loader-pkg
