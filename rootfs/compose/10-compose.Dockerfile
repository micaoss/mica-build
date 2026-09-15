# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# The product root: the Base root of the pinned mica-system-base release, and
# the selected local packages installed into it with dpkg.
#
# MICA_IMAGE_BASE_ROOTFS is that release's rootfs manifest for the platform, by
# digest (locks/mica-system-base.lock). The
# Base root already carries the upstream Debian lock of that release, its dpkg
# database and mica-system. This stage adds the selected archives of the
# imported pool and the Debian packages Base pins for later stages that the
# selection needs (the upstream rows of locks/mica-system-base.lock, verified into _out/cache/debian).
ARG MICA_IMAGE_BASE_ROOTFS
FROM --platform=$TARGETPLATFORM ${MICA_IMAGE_BASE_ROOTFS} AS composed
ARG MICA_ARCH
ARG MICA_BOARD
ARG MICA_PROFILE
ARG SOURCE_DATE_EPOCH
ARG COMPOSE_DIR
COPY ${COMPOSE_DIR}/ /mica-compose/
RUN --network=none \
    --mount=type=bind,source=rootfs/compose,target=/mica-scripts \
    --mount=type=bind,source=_out/debs,target=/mica-debs \
    --mount=type=bind,source=_out/cache/debian,target=/mica-upstream \
    sh /mica-scripts/compose-install.sh
