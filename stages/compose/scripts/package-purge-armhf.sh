#!/bin/sh
# On armhf, remove through the package manager what nothing on the device uses: libdb5.3t64, with
# pam_userdb.so, the one PAM module that loads it and no PAM stack names; and libsemanage2, libsepol2 and
# libsemanage-common, with the account tools that link libsemanage (the useradd family: every account exists
# by now; chage, which account-pin-shadow-dates.sh runs later, links neither). mica-system-base's armhf floor
# leaves them installed; this root is sized for a UBI region (mica-system-base:docs/floor-and-options.md).
#
# Called by stages/compose/compose-install.sh before compose-capture.sh, so the captured ownership, the
# inventory, the runtime selection and the size are this root's; elsewhere than armhf it does nothing.
set -eu
[ "${MICA_ARCH:?package-purge-armhf.sh needs MICA_ARCH}" = armhf ] || exit 0
LIBRARIES="libdb5.3t64 libsemanage2 libsepol2 libsemanage-common"
for p in ${LIBRARIES}; do
    [ "$(dpkg-query -W -f='${db:Status-Status}' "${p}" 2>/dev/null)" = installed ] ||
        { echo "error: ${p} is not installed; this purge is written against mica-system-base's armhf floor, which carries it" >&2; exit 1; }
done
# The files of packages that stay which name a purged library: the dynamic string table of an ELF object
# carries the soname it needs.
dependents=""
for owner in libpam-modules passwd; do
    for f in $(dpkg -L "${owner}"); do
        [ -f "${f}" ] && [ ! -L "${f}" ] || continue
        grep -q -e 'libdb-5\.3\.so' -e 'libsemanage\.so\.2' "${f}" && dependents="${dependents} ${f}"
    done
done
case " ${dependents} " in *"/security/pam_userdb.so "*) ;; *) echo "error: libpam-modules ships no pam_userdb.so linking libdb; the purge's premise moved" >&2; exit 1 ;; esac
case " ${dependents} " in *"/sbin/useradd "*) ;; *) echo "error: passwd's useradd does not link libsemanage; the purge's premise moved" >&2; exit 1 ;; esac
# shellcheck disable=SC2086
dpkg --purge --force-depends ${LIBRARIES}
# shellcheck disable=SC2086
rm -f ${dependents}
# A removed file leaves its package's file list and md5sums too: the ownership captured next is what is on disk.
for f in ${dependents}; do
    for list in /var/lib/dpkg/info/*.list; do
        grep -qxF "${f}" "${list}" || continue
        grep -vxF "${f}" "${list}" > "${list}.kept"; mv "${list}.kept" "${list}"
        sums="${list%.list}.md5sums"
        [ ! -f "${sums}" ] || { awk -v p="${f#/}" '$2 != p' "${sums}" > "${sums}.kept"; mv "${sums}.kept" "${sums}"; }
    done
    echo "package-purge-armhf: removed ${f}"
done
# The root's upstream identity (compose-install.sh: the Base root's rows and those beyond it) is what is
# installed, so the purged packages leave it too.
awk -F '\t' -v purged=" ${LIBRARIES} " 'index(purged, " " $1 " ") == 0' /mica-compose/upstream.tsv > /mica-compose/upstream.tsv.kept
mv /mica-compose/upstream.tsv.kept /mica-compose/upstream.tsv
# Nothing left in the root links libdb or libsemanage. libsepol was libsemanage's alone: libselinux names it
# only to dlopen it when it loads an SELinux policy, which this root does not.
left=$(grep -rl -e 'libdb-5\.3\.so' -e 'libsemanage\.so\.2' /usr/bin /usr/sbin /usr/lib 2>/dev/null || true)
[ -z "${left}" ] || { echo "error: still naming a purged library: ${left}" >&2; exit 1; }
