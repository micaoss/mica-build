# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# ONE producer for every board's package, mica-board-<board>: the board is
# the `board` context (boards/<board>, named by the instance), and stage.sh
# packs what its board.env and package/ say. Board hardware and storage
# policy are independent of the kernel and the boot firmware.
ARG MICA_BUILD_BASE
FROM ${MICA_BUILD_BASE} AS pack
COPY --from=packer pack.sh /usr/local/bin/pack.sh
COPY render.sh stage.sh /in/
COPY --from=board board.env /src/board.env
COPY --from=board package/ /in/package/
COPY --from=board package/control/ /in/control/
COPY --from=common fstab.in copyright /src/common/
# The ESP mount template, when the board has one (UEFI).
RUN [ ! -f /in/package/overlay/etc/systemd/system/boot.mount.in ] || \
    install -D -m 0644 /in/package/overlay/etc/systemd/system/boot.mount.in /src/overlay/etc/systemd/system/boot.mount.in
ARG MICA_DEB_VERSION
ARG MICA_DEB_ARCH
ARG SOURCE_DATE_EPOCH
# Provenance, written into the control file by pack.sh; see tools/deb/README.md.
ARG MICA_DEB_SOURCE_REPO
ARG MICA_DEB_INSTANCE
RUN bash /in/stage.sh
FROM scratch AS out
COPY --from=pack /out/ /
