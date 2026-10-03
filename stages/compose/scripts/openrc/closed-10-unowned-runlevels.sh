#!/bin/sh
# Runlevel membership is payload: every package links its own services. A package configured after mica-openrc
# that runs update-rc.d (bluez adds Debian's `bluetooth`) leaves a link no package owns, which would start a SysV
# script beside the package's own service; it is removed here, while dpkg can still say who owns a path. OpenRC's
# `cgroups`, which mica-openrc keeps, stays.
#
# Called from stages/compose/90-pack.Dockerfile (closed stage) through init-steps.sh.
set -eu
removed=0
kept=0
for link in /etc/runlevels/*/*; do
    [ -L "${link}" ] || continue
    if [ "${link}" = /etc/runlevels/sysinit/cgroups ] || dpkg-query -S "${link}" >/dev/null 2>&1; then
        kept=$((kept + 1))
        continue
    fi
    rm -f "${link}"
    removed=$((removed + 1))
    echo "runlevels: removed ${link}, which no package owns"
done
[ "${kept}" -gt 0 ] ||
    { echo "error: no runlevel link is left; mica-openrc links its own services, so a root with none is not one this step recognises" >&2; exit 1; }
echo "runlevels: ${kept} link(s) kept, ${removed} removed"
