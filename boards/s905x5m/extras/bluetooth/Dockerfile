# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
ARG MICA_BUILD_BASE
FROM ${MICA_BUILD_BASE} AS pack
COPY --from=tooling src/ /tooling/src/
COPY --from=board firmware/component-copyright /in/copyright
COPY --from=bin . /stage/
COPY hwinit/hwinit-bluetooth hwinit/mica-bluetooth.service init/bluetooth.conf /in/
COPY control/mica-s905x5m-bluetooth.control /in/control
COPY shlibs.sh /in/shlibs.sh
ARG MICA_DEB_ARCH
ARG SOURCE_DATE_EPOCH
# Provenance, written into the control file by mica-build-tools' deb pack (its design 3.3.2).
ARG MICA_DEB_SOURCE_REPO
RUN set -eu; \
    install -D -m 0755 /in/hwinit-bluetooth /stage/usr/lib/mica/hwinit-bluetooth; \
    install -D -m 0644 /in/bluetooth.conf /stage/etc/mica/bluetooth.conf; \
    install -D -m 0644 /in/mica-bluetooth.service /stage/usr/lib/systemd/system/mica-bluetooth.service; \
    install -d /stage/etc/systemd/system/multi-user.target.wants; \
    ln -s /usr/lib/systemd/system/mica-bluetooth.service /stage/etc/systemd/system/multi-user.target.wants/; \
    install -D -m 0644 /in/copyright /stage/usr/share/doc/mica-s905x5m-bluetooth/copyright; \
    shlibs=$(bash /in/shlibs.sh /stage mica-s905x5m-bluetooth); \
    bun /tooling/src/cli.ts deb pack --root /stage --control /in/control --arch "$MICA_DEB_ARCH" --out /out \
        --substitute "shlibs:Depends=$shlibs"
FROM scratch AS out
COPY --from=pack /out/ /
