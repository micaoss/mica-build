#!/bin/bash
# mica-build-side: container -- runs inside the install-closure roots tests/gates/install-closure.ts builds, never on the host.
# The SAME manifest with `mqtt` declined, and the same ldd sweep over it.
#
# Check the reduced manifest independently so optional MQTT dependencies cannot
# conceal unresolved libraries in another package.
set -uo pipefail
. /in/lib.sh

PKGS="$(tr '\n' ' ' </in/packages-declined.txt)"
PKG_N="$(grep -c . /in/packages-declined.txt || true)"
echo "install-closure: declined-mqtt: installing ${PKG_N} package(s): ${PKGS}"

install_set ${PKGS}
echo "install-closure: declined-mqtt: dpkg exited ${INSTALL_STATUS}"
if [ "${INSTALL_STATUS}" -eq 0 ]; then
    pass "declined-mqtt: dpkg unpacked and configured the ${PKG_N}-package set with mqtt declined"
else
    fail "declined-mqtt: dpkg exited ${INSTALL_STATUS}"
    tail -n 40 /tmp/install.log
fi

# mica-mqttd really absent. Without this the sweep below runs over a root that
# still holds the package whose dependencies are the entire question, and it
# could not have failed.
pkg_status mica-mqttd '${Status}'
case "${PKG_STATUS}" in
'install ok installed'*) fail "declined-mqtt: mica-mqttd is installed in the root that declined it, so this sweep is over the same closure as the full root and proves nothing about what its dependencies were carrying" ;;
*) pass "declined-mqtt: mica-mqttd is absent, as required by the reduced manifest" ;;
esac

ALL_PATHS=/tmp/all-paths.txt
collect_payload_paths "${ALL_PATHS}" ${PKGS}
PATHS_N="$(grep -c . "${ALL_PATHS}" || true)"
[ "${PATHS_N}" -gt 0 ] ||
    fail "declined-mqtt: dpkg -L over ${PKG_N} package(s) listed no path at all, so the sweep below examined nothing"
ldd_sweep "${ALL_PATHS}" "mqtt declined"

dump_pkgdb

echo "COUNT packages ${PKG_N}"
echo "COUNT ldd ${LDD_N}"
echo "COUNT elfs ${ELF_N}"
echo "RESULT-DECLINED: ${PASS_N} pass, ${FAIL_N} fail"
echo "-- end declined --"
