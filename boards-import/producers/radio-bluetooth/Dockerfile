# syntax=docker/dockerfile:1@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32
# check=skip=InvalidDefaultArgInFrom
# The radio-bluetooth producer: the `mica-bluetooth` package.
#
#   bash tools/deb/build.sh --producer radio-bluetooth --arch all
#
# Its own producer and not a stanza in a combined radios build: a board picks
# Wi-Fi and Bluetooth independently, so each radio is its own boundary. Wi-Fi
# is radio-wifi. No path is owned by both and neither names
# the other in any relationship field.
#
# This file only STAGES and PACKS. Nothing is compiled here: the payload is a
# unit file and a POSIX shell script copied byte-identical out of the tree
# that ships them, plus the symlinks that enable and mount for them.
#
# No default for the base: a driver that failed to pass the argument would
# otherwise build from a floating tag.
ARG MICA_BUILD_BASE

FROM ${MICA_BUILD_BASE} AS pack

# pack.sh comes over as a named context rather than out of the image. It is the
# packaging CONTRACT, shared by every producer, and tools/deb/README.md
# requires this shape: an edit to the packer then takes effect without
# rebuilding an image.
COPY --from=packer pack.sh /usr/local/bin/pack.sh

COPY --from=family copyright /in/copyright
COPY control/ /in/control/

# The unit body and the attach program, out of the tree that ships them today,
# rather than re-entered here. They are copied and never edited: a second
# rendering of a unit is a file that drifts, and the drift would show up as a
# device that mounts nothing while every gate stayed green.
COPY --from=radio-units var-lib-bluetooth.mount /in/units/
COPY --from=radio-hwinit hwinit-bt mica-bt.service /in/hwinit/

ARG MICA_DEB_VERSION
ARG MICA_DEB_ARCH
ARG SOURCE_DATE_EPOCH
# Provenance, written into the control file by pack.sh; see tools/deb/README.md.
ARG MICA_DEB_SOURCE_REPO

# The attach program, its unit, that unit's enablement link and the
# pairing-key mount.
#
# The unit goes to /usr/lib/systemd/system and the wants-link to
# /etc/systemd/system/multi-user.target.wants. The link is unconditional
# payload while the unit carries ConditionPathExists=/etc/mica/bt.conf, so on a
# board that ships no bt.conf the unit is enabled and inert rather than
# failing -- which is what lets this package hold the Bluetooth service while
# /etc/mica/bt.conf, the radio kernel modules and the firmware stay board facts
# in mica-board-cx3576.
#
# Enablement here is package-owned files: the image root is an immutable
# dm-verity squashfs, so nothing runs `systemctl enable` on it.
RUN set -eu; \
    install -d -m 0755 /stage/bluetooth/etc/systemd/system/local-fs.target.wants \
        /stage/bluetooth/etc/systemd/system/multi-user.target.wants; \
    install -D -m 0755 /in/hwinit/hwinit-bt /stage/bluetooth/usr/lib/mica/hwinit-bt; \
    install -D -m 0644 /in/hwinit/mica-bt.service \
        /stage/bluetooth/usr/lib/systemd/system/mica-bt.service; \
    ln -s /usr/lib/systemd/system/mica-bt.service \
        /stage/bluetooth/etc/systemd/system/multi-user.target.wants/mica-bt.service; \
    install -m 0644 /in/units/var-lib-bluetooth.mount /stage/bluetooth/etc/systemd/system/; \
    ln -s /etc/systemd/system/var-lib-bluetooth.mount \
        /stage/bluetooth/etc/systemd/system/local-fs.target.wants/var-lib-bluetooth.mount; \
    install -D -m 0644 /in/copyright /stage/bluetooth/usr/share/doc/mica-bluetooth/copyright; \
    pack.sh --root /stage/bluetooth --control /in/control/mica-bluetooth.control \
        --version "${MICA_DEB_VERSION}" --arch "${MICA_DEB_ARCH}" --out /out

# The export stage, the shape mica-core:pkgs/micad/Dockerfile ends in:
# `-o type=local` writes this stage's filesystem into _out/debs/<arch>/pool/
# and nothing here installs into a root.
FROM scratch AS out
COPY --from=pack /out/ /
