#!/bin/bash
# mica-build-side: container -- runs inside the install-closure roots tests/gates/install-closure.ts builds, never on the host.
# ONE radio package into a Base root. Three roots, one per package, because the
# claim under test is that they are independent -- a single root holding all
# three would answer a question nobody asked.
set -uo pipefail
. /in/lib.sh

PKG="$1"
OTHERS="$2"

# That the OTHER radio packages were in the pool, asserted before the install:
# "this root does not hold mica-bluetooth" is worth nothing if mica-bluetooth
# was not there to be installed in the first place.
AVAILABLE_N=0
for o in ${OTHERS}; do
    if grep -cx "Package: ${o}" /dist/Packages >/dev/null; then
        AVAILABLE_N=$((AVAILABLE_N + 1))
    else
        fail "${o} is not in the pool, so '${PKG} did not pull ${o}' would be a statement about an absent package"
    fi
done
[ "${AVAILABLE_N}" -ne 2 ] ||
    pass "${PKG}: both other radio packages (${OTHERS}) were in the pool"

install_set "${PKG}"
if [ "${INSTALL_STATUS}" -eq 0 ]; then
    pass "${PKG} configures on its own on the Base root"
else
    fail "${PKG} alone did not configure: exit ${INSTALL_STATUS}"
    tail -n 30 /tmp/install.log
fi

for o in ${OTHERS}; do
    # Captured and matched with `case`, never `dpkg-query | grep -q`: -q closes
    # the pipe at its first match and pipefail then reports the pipeline as
    # having FAILED because the pattern was found. tests/gates/shell-pipefail-lint.test.ts
    # refuses that shape by name.
    pkg_status "${o}" '${Status}'
    case "${PKG_STATUS}" in
    'install ok installed'*) fail "${PKG} pulled ${o} into its root; the three radio packages are meant to be independent" ;;
    *) pass "${PKG} did not pull ${o}" ;;
    esac
done

# rfkill, the shared dependency, in both halves: the installed package declares
# it, and the root actually holds it.
deps="$(dpkg-query -W -f='${Depends}' "${PKG}" 2>/dev/null || true)"
case " ${deps//,/ } " in
*" rfkill "*) pass "${PKG} declares rfkill in Depends: ${deps}" ;;
*) fail "${PKG}'s Depends does not name rfkill: '${deps}'" ;;
esac
st="$(dpkg-query -W -f='${Status}' rfkill 2>/dev/null || true)"
case "${st}" in
'install ok installed'*) pass "rfkill is installed in ${PKG}'s root" ;;
*) fail "rfkill is not installed in ${PKG}'s root: dpkg-query says '${st:-nothing at all}'" ;;
esac

# The payload, for the disjointness comparison the HOST makes across the three
# roots -- no root can see another's. Non-directory paths only: directories are
# shared on purpose.
PAYLOAD_N=0
while IFS= read -r path; do
    case "${path}" in /*) ;; *) continue ;; esac
    if [ -d "${path}" ] && [ ! -L "${path}" ]; then continue; fi
    PAYLOAD_N=$((PAYLOAD_N + 1))
    echo "PAYLOAD: ${path}"
done < <(dpkg -L "${PKG}" 2>/dev/null || true)
[ "${PAYLOAD_N}" -gt 0 ] ||
    fail "${PKG} lists no non-directory payload path, so the disjointness comparison would be over an empty set"

echo "COUNT payload ${PAYLOAD_N}"
echo "RESULT-RADIO ${PKG}: ${PASS_N} pass, ${FAIL_N} fail"
echo "-- end radio ${PKG} --"
