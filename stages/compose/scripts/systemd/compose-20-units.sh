#!/bin/sh
# The product's ENABLE_UNITS: the units 40-mica-build.preset enables (src/rootfs/build.ts writes an `enable` line for
# each, ahead of every other rule), linked into the targets their [Install] WantedBy= names, as `systemctl enable`
# would. The preset is the decision, which keeps closed-20-preset-enforce.sh from removing the link; the link's
# consumer in src/rootfs/runtime/consumers.json names this step as what generated it.
#
# Called from stages/compose/compose-install.sh through init-steps.sh.
set -eu
fail() { echo "error: $*" >&2; exit 1; }
for unit in $(sed -n 's/^enable //p' /usr/lib/systemd/system-preset/40-mica-build.preset); do
    file="/usr/lib/systemd/system/${unit}"
    [ -f "${file}" ] || fail "the product enables ${unit} (ENABLE_UNITS), and no package installed ${file}"
    targets=$(sed -n 's/^WantedBy=//p' "${file}")
    [ -n "${targets}" ] || fail "the product enables ${unit} (ENABLE_UNITS), and ${file} names no WantedBy="
    for target in ${targets}; do
        mkdir -p "/etc/systemd/system/${target}.wants"
        ln -sfn "${file}" "/etc/systemd/system/${target}.wants/${unit}"
        echo "compose: ${unit} enabled in ${target} (ENABLE_UNITS)"
    done
done
