#!/usr/bin/env bash
# mica-build-side: container -- stage and pack one board's package, mica-board-<board>.
#
# Everything staged is read out of the board's own directory (the `board`
# context): board.env says which layout to render and which hardware-init
# concerns the board has, package/ holds what the package ships. Nothing here
# names a board; the same script packs every board.
set -euo pipefail
bash /in/render.sh /src /render
. /src/board.env
PKG="mica-board-${LAYOUT_BOARD}"; ROOT="/stage/${PKG}"
install -d -m 0755 "${ROOT}/etc/repart.d"
install -m 0644 /render/fstab "${ROOT}/etc/fstab"
cp /render/repart.d/*.conf "${ROOT}/etc/repart.d/"
install -d -m 0755 "${ROOT}/etc/systemd/system"
cp -a /render/systemd-repart.service.d "${ROOT}/etc/systemd/system/"
# A UEFI board mounts its ESP read-only at /boot; the renderer wrote the unit.
if [ -f /render/boot.mount ]; then
    install -D -m 0644 /render/boot.mount "${ROOT}/etc/systemd/system/boot.mount"
    install -d -m 0755 "${ROOT}/boot" "${ROOT}/etc/systemd/system/local-fs.target.wants"
    ln -s /etc/systemd/system/boot.mount "${ROOT}/etc/systemd/system/local-fs.target.wants/boot.mount"
fi
# The overlay ships wholesale, byte for byte including symlinks and modes:
# systemd drop-ins amending generic units, presets, the console policy, an
# indicator program and its unit. A template (*.in) is the renderer's input,
# not a shipped file.
if [ -d /in/package/overlay ]; then
    (cd /in/package/overlay && find . -type f -name '*.in' -prune -o \( -type f -o -type l \) -print0 | tar --null -T - -cf -) |
        tar -C "${ROOT}" -xf -
    # A preset set is asserted non-empty when the overlay carries the
    # directory: a glob that matched nothing would pack no preset, getty@tty1
    # would resolve to enabled through 90-systemd.preset, and a board with a
    # display would boot to a login prompt with this build green.
    if [ -d /in/package/overlay/usr/lib/systemd/system-preset ]; then
        n="$(find /in/package/overlay/usr/lib/systemd/system-preset -maxdepth 1 -name '*.preset' | wc -l)"
        [ "${n}" -gt 0 ] || { echo "error: boards/${LAYOUT_BOARD}/package/overlay/usr/lib/systemd/system-preset holds no *.preset" >&2; exit 1; }
        echo "presets: staged ${n} board preset(s)"
    fi
fi
# Hardware init: every concern in BOARD_HWINIT_CONFS whose fact this package
# carries (package/init/<n>.conf) ships as /etc/mica/<n>.conf, with the
# program and unit that read it when this package carries them
# (package/hwinit/hwinit-<n>, mica-<n>.service) and the udev rules and
# .link files beside them. A fact without a program here is read by a
# program another package ships (bt.conf by mica-bluetooth); a concern
# without a fact here is shipped whole by one of the board's extras.
for n in ${BOARD_HWINIT_CONFS:-}; do
    conf="/in/package/init/${n}.conf"
    [ -f "${conf}" ] || continue
    install -D -m 0644 "${conf}" "${ROOT}/etc/mica/${n}.conf"
    script="/in/package/hwinit/hwinit-${n}"; unit="/in/package/hwinit/mica-${n}.service"
    [ -f "${script}" ] || continue
    [ -f "${unit}" ] || { echo "error: boards/${LAYOUT_BOARD}/package/hwinit/hwinit-${n} has no unit to run it (mica-${n}.service)" >&2; exit 1; }
    install -D -m 0755 "${script}" "${ROOT}/usr/lib/mica/hwinit-${n}"
    install -D -m 0644 "${unit}" "${ROOT}/usr/lib/systemd/system/mica-${n}.service"
    # Enablement is a file this package owns: the root is sealed before the device boots.
    install -d -m 0755 "${ROOT}/etc/systemd/system/multi-user.target.wants"
    ln -s "/usr/lib/systemd/system/mica-${n}.service" "${ROOT}/etc/systemd/system/multi-user.target.wants/mica-${n}.service"
    for r in /in/package/hwinit/*-mica-"${n}"-*.rules; do
        [ -e "${r}" ] || continue
        install -D -m 0644 "${r}" "${ROOT}/usr/lib/udev/rules.d/$(basename "${r}")"
    done
    for l in /in/package/hwinit/*-mica-"${n}"-*.link; do
        [ -e "${l}" ] || continue
        install -D -m 0644 "${l}" "${ROOT}/usr/lib/systemd/network/$(basename "${l}")"
    done
done
# The board's own copyright when it has one, else the shared one.
copyright=/in/package/copyright; [ -f "${copyright}" ] || copyright=/src/common/copyright
install -D -m 0644 "${copyright}" "${ROOT}/usr/share/doc/${PKG}/copyright"
pack.sh --root "${ROOT}" --control "/in/control/${PKG}.control" \
    --version "${MICA_DEB_VERSION}" --arch "${MICA_DEB_ARCH}" --out /out
