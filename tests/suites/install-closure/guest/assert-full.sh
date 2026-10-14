#!/bin/bash
# mica-build-side: container -- runs inside the install-closure roots tests/gates/install-closure.ts builds, never on the host.
# The clean-root install, and everything only an installed root can answer.
# Never exits non-zero: the host judges the report, and a stage that died would
# take its report with it.
set -uo pipefail
. /in/lib.sh

PKGS="$(tr '\n' ' ' </in/packages.txt)"
PKG_N="$(grep -c . /in/packages.txt || true)"
echo "install-closure: installing ${PKG_N} package(s) from the local pool: ${PKGS}"

# The whole set in ONE transaction, which is the question being asked: whether
# the Base root and the set satisfy the closure of what a board resolves to.
# Installing them one at a time would answer a weaker question and would hide a
# conflict between two members of the same set.
install_set ${PKGS}
echo "install-closure: dpkg exited ${INSTALL_STATUS}"
if [ "${INSTALL_STATUS}" -eq 0 ]; then
    pass "dpkg unpacked and configured the ${PKG_N}-package set on the Base root in one transaction"
else
    fail "dpkg exited ${INSTALL_STATUS} over the resolved ${PKG_N}-package set"
fi
tail -n 40 /tmp/install.log

audit="$(dpkg --audit 2>&1)"
if [ -z "${audit}" ]; then
    pass "dpkg --audit reports nothing: no package is unpacked-but-unconfigured"
else
    fail "dpkg --audit reports: $(printf '%s' "${audit}" | tr '\n' ' ')"
fi

# --- every resolved package installed and configured
INSTALLED_N=0
for p in ${PKGS}; do
    st="$(dpkg-query -W -f='${Status} ${Version}' "${p}" 2>/dev/null || true)"
    case "${st}" in
    "install ok installed "*) INSTALLED_N=$((INSTALLED_N + 1)) ;;
    *) fail "${p} is not installed and configured: dpkg-query says '${st:-nothing at all}'" ;;
    esac
done
if [ "${PKG_N}" -gt 0 ] && [ "${INSTALLED_N}" -eq "${PKG_N}" ]; then
    pass "all ${INSTALLED_N} resolved packages are 'install ok installed'"
fi
[ "${PKG_N}" -gt 0 ] ||
    fail "the resolver named NO package, so this root is the bare Base root and every assertion below is over nothing"

# --- the payload paths
#
# Derived from dpkg's own record of what each package shipped, so a package that
# gained or lost a file is covered without this script being edited. Directories
# are counted apart: a shared directory is not a promise either package made
# alone.
PATHS_N=0
DIRS_N=0
MISSING=""
UNITS_N=0
WANTS_N=0
WANTS_BAD=""
ALL_PATHS=/tmp/all-paths.txt
collect_payload_paths "${ALL_PATHS}" ${PKGS}
while IFS= read -r path; do
    case "${path}" in /*) ;; *) continue ;; esac
    if [ -L "${path}" ]; then
        :
    elif [ -d "${path}" ]; then
        DIRS_N=$((DIRS_N + 1))
        continue
    elif [ ! -e "${path}" ]; then
        MISSING="${MISSING} ${path}"
        continue
    fi
    PATHS_N=$((PATHS_N + 1))
    case "${path}" in
    */systemd/system/*.wants/*)
        WANTS_N=$((WANTS_N + 1))
        # The link has to land on a unit FILE, and the resolution happens in the
        # INSTALLED root: no archive can say whether the unit its wants-link
        # names was shipped by anybody at all. A dangling one is a service
        # systemd will not start and nothing else in this tree would notice.
        [ -f "${path}" ] || WANTS_BAD="${WANTS_BAD} ${path}"
        ;;
    */systemd/system/*.service | */systemd/system/*.mount | */systemd/system/*.target | */systemd/system/*.socket | */systemd/system/*.timer)
        UNITS_N=$((UNITS_N + 1))
        ;;
    esac
done <"${ALL_PATHS}"
echo "install-closure: ${PATHS_N} non-directory payload path(s) and ${DIRS_N} directory entr(ies) over ${PKG_N} package(s)"
if [ "${PATHS_N}" -eq 0 ]; then
    fail "dpkg -L over ${PKG_N} installed package(s) listed NO non-directory path, so the existence check examined nothing"
elif [ -z "${MISSING}" ]; then
    pass "all ${PATHS_N} non-directory payload paths are present in the installed root"
else
    fail "payload path(s) dpkg records and the root does not have:${MISSING}"
fi
echo "install-closure: ${UNITS_N} unit path(s) and ${WANTS_N} wants-symlink(s) in the payload"
if [ "${WANTS_N}" -eq 0 ]; then
    fail "the payload carries NO wants-symlink at all, so the resolution check examined nothing. Enablement in this tree is package-owned symlink payload, and a set carrying none of it is a set nothing starts"
elif [ -z "${WANTS_BAD}" ]; then
    pass "all ${WANTS_N} wants-symlinks resolve to a unit file present in the root"
else
    fail "wants-symlink(s) that do not resolve to a unit file:${WANTS_BAD}"
fi

# --- enablement in the root that no package payload put there
#
# This tree's rule is that enablement IS package-owned symlink payload: no
# composer, script or maintainer script calls `systemctl enable`, and each
# producer declares its multi-user.target count in ENABLEMENT. A DEBIAN
# package's postinst does not know that rule -- openssh-server left its
# [Install] symlink behind, and the composed uefi-x64 root shipped ssh.service
# enabled where the chain image did not (before the SSH server was dropbear).
#
# Only an installed root can see it: the symlink is in nobody's archive. Reported by name and NOT failed: the Mica OS rule
# governs Mica OS producers, and what an upstream Debian maintainer script does with
# its own unit is a fact for the composer workstream to rule on rather than one
# this gate should decide by going red.
# The classification is PAYLOAD versus NOT, asked of dpkg about the LINK itself
# -- not about the unit it points at. A .wants symlink that some package's file
# list claims was shipped, whoever shipped it: systemd's own
# sockets.target.wants links are payload exactly as Mica OS's multi-user.target.wants
# links are. One that NO package's file list claims was written by a maintainer
# script, and that is the whole category. Classifying by the TARGET's owner
# instead would put all seventy of Debian's vendor-shipped links in the finding
# and bury the one that matters.
#
# One pass over every installed package's file list rather than a `dpkg -S` per
# link: a hundred forks under the emulated executor is minutes, and this answers
# the same question once.
OWNED_WANTS=/tmp/owned-wants.txt
dpkg-query -Wf='${binary:Package}\n' 2>/dev/null | xargs -r dpkg -L 2>/dev/null |
    grep -F '.wants/' | LC_ALL=C sort -u >"${OWNED_WANTS}" || true
OWNED_WANTS_N="$(grep -c . "${OWNED_WANTS}" || true)"
[ "${OWNED_WANTS_N}" -gt 0 ] ||
    fail "no installed package's file list names a single .wants path, so the classification below would call every symlink in the root undeclared"

ROOT_WANTS_N=0
UNDECLARED_N=0
for d in /etc/systemd/system/*.wants /usr/lib/systemd/system/*.wants; do
    [ -d "${d}" ] || continue
    for link in "${d}"/*; do
        { [ -e "${link}" ] || [ -L "${link}" ]; } || continue
        ROOT_WANTS_N=$((ROOT_WANTS_N + 1))
        grep -Fxc -- "${link}" "${OWNED_WANTS}" >/dev/null && continue
        UNDECLARED_N=$((UNDECLARED_N + 1))
        target="$(readlink "${link}" 2>/dev/null || echo '(not a symlink)')"
        owner="$(dpkg -S "$(readlink -f "${link}" 2>/dev/null)" 2>/dev/null | cut -d: -f1 | sed -n '1p')"
        echo "UNDECLARED-ENABLEMENT: ${link} -> ${target}, in no package's file list; the unit it enables belongs to ${owner:-no package at all}, so a maintainer script wrote this link"
    done
done
echo "install-closure: ${ROOT_WANTS_N} .wants symlink(s) present in the installed root, ${OWNED_WANTS_N} claimed by some package's file list (${WANTS_N} of them mica payload), ${UNDECLARED_N} written by a maintainer script"
if [ "${ROOT_WANTS_N}" -eq 0 ]; then
    fail "the installed root holds NO .wants symlink at all, so this enumeration examined nothing -- not even the base system's"
elif [ "${UNDECLARED_N}" -eq 0 ]; then
    pass "every one of the ${ROOT_WANTS_N} .wants symlinks in the root is some package's payload; no maintainer script enabled a unit"
fi

# --- the accounts the units name
#
# Derived from the units themselves rather than from a list of names: a `User=`
# in a shipped unit IS the promise, and it is the one that fails at boot with
# "Failed to determine user credentials" when the package that owns the account
# did not create it.
ACCOUNTS_N=0
ACCOUNTS_BAD=""
SEEN=" "
while IFS= read -r unit; do
    [ -f "${unit}" ] || continue
    while IFS= read -r line; do
        kind="${line%%=*}"
        who="${line#*=}"
        [ -n "${who}" ] || continue
        case "${SEEN}" in *" ${kind}:${who} "*) continue ;; esac
        SEEN="${SEEN}${kind}:${who} "
        ACCOUNTS_N=$((ACCOUNTS_N + 1))
        case "${kind}" in
        User) getent passwd "${who}" >/dev/null 2>&1 || ACCOUNTS_BAD="${ACCOUNTS_BAD} ${unit}:User=${who}" ;;
        Group) getent group "${who}" >/dev/null 2>&1 || ACCOUNTS_BAD="${ACCOUNTS_BAD} ${unit}:Group=${who}" ;;
        esac
    done < <(grep -hE '^(User|Group)=' "${unit}" 2>/dev/null || true)
done < <(grep -E '/systemd/system/[^/]*\.(service|socket|mount)$' "${ALL_PATHS}" | sort -u)
echo "install-closure: ${ACCOUNTS_N} distinct User=/Group= declaration(s) in the shipped units"
if [ "${ACCOUNTS_N}" -eq 0 ]; then
    fail "no shipped unit names a User= or Group= at all, so the account check examined nothing"
elif [ -z "${ACCOUNTS_BAD}" ]; then
    pass "all ${ACCOUNTS_N} User=/Group= declarations resolve in the installed root's passwd/group databases"
else
    fail "unit account declaration(s) with no matching entry in the installed root:${ACCOUNTS_BAD}"
fi

# --- ldd over the payload. The same sweep the mqtt-declined root runs, which is
# the whole point of it being a function in /in/lib.sh rather than written twice.
ldd_sweep "${ALL_PATHS}" "full resolution"

# --- the version commands
#
# EMULATED comes from the Dockerfile stage: 1 when this root is a foreign
# architecture running under the buildkit executor's emulator. A declared
# executor limit is consulted only then, and only when the status AND the stderr
# both match what that component declared.
COMPONENTS_N=0
LIMITED_N=0
while IFS="$(printf '\t')" read -r name path expected origin lim_status lim_stderr; do
    [ -n "${name}" ] || continue
    [ -e "${path}" ] || continue
    COMPONENTS_N=$((COMPONENTS_N + 1))
    status=0
    "${path}" --version >/tmp/vout 2>/tmp/verr || status=$?
    out="$(cat /tmp/vout /tmp/verr)"
    stderr="$(cat /tmp/verr)"
    said="$(printf '%s' "${out}" | sed -n '1,2p' | tr '\n' ' ')"
    # The expected version has to appear as a whole token: a bare substring test
    # would accept 5.8.60 for a pin of 5.8.6, and `catatonit` reports
    # `tini version 0.2.1_catatonit`, where the boundary is an underscore.
    #
    # `grep -c ... >/dev/null` and not `grep -q`: -q on the right of a pipe under
    # pipefail reports the pipeline as failing BECAUSE the pattern matched, which
    # tests/gates/shell-pipefail-lint.test.ts refuses by name.
    if [ "${status}" -eq 0 ] &&
        printf '%s' "${out}" | grep -cE "(^|[^0-9A-Za-z.])$(printf '%s' "${expected}" | sed 's/\./\\./g')([^0-9A-Za-z.]|\$)" >/dev/null; then
        pass "${name} --version reports ${expected} (${origin}) [said: \"${said}\"]"
        continue
    fi
    excused=0
    if [ "${EMULATED:-0}" = 1 ] && [ "${lim_status}" != "-" ] && [ "${status}" = "${lim_status}" ]; then
        case "${stderr}" in *"${lim_stderr}"*) excused=1 ;; esac
    fi
    if [ "${excused}" -eq 1 ]; then
        LIMITED_N=$((LIMITED_N + 1))
        echo "EXECUTOR-LIMITED: ${name} exited ${status} under the emulated buildkit executor with its declared signature (\"${lim_stderr}\") -- the emulator's limit, not the binary's. The native route holds this entry strict"
        continue
    fi
    fail "${name} --version exited ${status} and did not report ${expected} (${origin}) [said: \"${said}\"]"
done </in/components.tsv
echo "install-closure: ${COMPONENTS_N} imported component(s) asked for a version, ${LIMITED_N} executor-limited"
[ "${COMPONENTS_N}" -gt 0 ] ||
    fail "no component named in components.tsv is present in this root, so no version was checked at all"

# Every package this root ended up holding, for the host to diff against the
# mqtt-declined root's. What a declined feature TOOK WITH IT is the fact that
# decides whether that root's ldd sweep could have failed at all.
dump_pkgdb

echo "COUNT packages ${INSTALLED_N}"
echo "COUNT paths ${PATHS_N}"
echo "COUNT wants ${WANTS_N}"
echo "COUNT rootwants ${ROOT_WANTS_N}"
echo "COUNT undeclared ${UNDECLARED_N}"
echo "COUNT accounts ${ACCOUNTS_N}"
echo "COUNT ldd ${LDD_N}"
echo "COUNT elfs ${ELF_N}"
echo "COUNT components ${COMPONENTS_N}"
echo "COUNT limited ${LIMITED_N}"
echo "RESULT-FULL: ${PASS_N} pass, ${FAIL_N} fail"
echo "-- end full --"
