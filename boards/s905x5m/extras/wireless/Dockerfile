# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
ARG MICA_BUILD_BASE
FROM ${MICA_BUILD_BASE} AS pack
COPY --from=packer pack.sh /usr/local/bin/pack.sh
COPY --from=common copyright /in/copyright
COPY hwinit/ /in/hwinit/
COPY init/ /in/init/
COPY --from=board components/bm201-front-panel/dist/ /in/front-panel/
COPY stage.sh /in/
COPY control/ /in/control/
ARG MICA_DEB_VERSION
ARG MICA_DEB_ARCH
ARG SOURCE_DATE_EPOCH
# Provenance, written into the control file by pack.sh; see tools/deb/README.md.
ARG MICA_DEB_SOURCE_REPO
RUN bash /in/stage.sh
FROM scratch AS out
COPY --from=pack /out/ /
