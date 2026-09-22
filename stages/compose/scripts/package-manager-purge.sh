#!/bin/sh
# Remove package management from the packed root, and prove what survived.
#
# Called from stages/compose/90-pack.Dockerfile (closed stage), where the reasoning lives.

set -eu
# The logs go too, and they are the one part of this that has a prerequisite:
# /var/log/dpkg.log is what the stage-order claim is measured with, so
# package-manager-logs-capture.sh must already have taken it out of the tree.
# Refuse rather than remove it, because a purge that quietly destroyed the
# instrument would read as a clean image and cost the claim silently.
[ -s /rootfs-report.pkglogs/dpkg.log ] ||
    { echo "error: the package-manager logs were not captured before this purge; /rootfs-report.pkglogs/dpkg.log is missing or empty. Removing /var/log/dpkg.log without capturing it first destroys the instrument the stage-order claim is measured with -- rootfs/README.md, 'Check the apt order directly' -- and nothing downstream can tell that from a build that never needed it" >&2; exit 1; }
# THE ENABLEMENT OF THE MACHINERY THIS PURGE REMOVES, found by asking dpkg who
# OWNS each unit rather than by matching its name.
#
# apt ships apt-daily.timer and apt-daily-upgrade.timer, dpkg ships
# dpkg-db-backup.timer, and each ships the wants-symlink that enables it -- into
# /etc/systemd/system/timers.target.wants, the level that overrides vendor
# defaults. On a root whose package manager is about to be deleted they fire
# daily and fail daily, and nothing else in the image is wrong enough to notice.
#
# THIS RUNS FIRST because it is the only step here that needs the dpkg database,
# and the `rm -rf` below deletes it. That ordering is the whole reason this
# check lives in this file rather than in the finalizer's residue stripper,
# which runs in the pack stage over a tree with no /var/lib/dpkg left.
#
# BY OWNERSHIP AND NOT BY NAME, and that is the point of the change. The old
# spelling removed nine literal paths and then asserted `find -name 'apt-daily*'
# -o -name 'dpkg-db-backup*'` found nothing -- so a fourth timer, shipped by apt
# or dpkg under any other name, survived the removal AND the assertion. The
# membership test is a set of PACKAGE names, which is the granularity the purge
# is actually about: it removes apt's and dpkg's binaries, so it removes what
# apt and dpkg enabled, whatever those units are called.
#
# The by-name assertion is KEPT, below, as the check on this mechanism rather
# than as the mechanism. If this sweep stops working, that assertion is what
# says so, and it can only say so because it no longer does the removing.
PURGED_PACKAGES="apt dpkg"
owned_by_purged() {
    _owner="$(dpkg-query -S "$1" 2>/dev/null | sed 's/:.*//')" || return 1
    [ -n "${_owner}" ] || return 1
    for _p in $(printf '%s' "${_owner}" | tr ',' ' '); do
        for _q in ${PURGED_PACKAGES}; do
            [ "${_p}" != "${_q}" ] || return 0
        done
    done
    return 1
}

# PASS 1, THE ENABLEMENT LINKS, and ownership is asked of THE UNIT THE LINK
# POINTS AT rather than of the link.
#
# This is not a refinement, it is the whole mechanism: NO PACKAGE OWNS A .wants
# LINK. Measured in a clean trixie root -- all four links under
# timers.target.wants answer "no package owns this path", while every unit they
# point at answers apt, apt, dpkg and util-linux. deb-systemd-helper writes
# those links from a maintainer script, so they are in no file list at all.
#
# The first version of this asked dpkg about the LINK, found nothing, skipped
# every one of them, and the by-name assertion below caught it on the first real
# build -- both paths, identically, because this file is the shared finalizer.
# A sibling had measured the same fact from the other side (asking who owns the
# LINK is how maintainer-script enablement is IDENTIFIED); the two uses are
# opposite and the sentences describing them are nearly the same.
#
# Before pass 2, because that one removes the units these links resolve through.
purged_links=0
purged_link_names=""
for _link in /etc/systemd/system/*.target.wants/*; do
    { [ -e "${_link}" ] || [ -L "${_link}" ]; } || continue
    _unit="$(readlink -f "${_link}" 2>/dev/null)" || continue
    [ -n "${_unit}" ] || continue
    owned_by_purged "${_unit}" || continue
    rm -f "${_link}"
    purged_links=$((purged_links + 1))
    purged_link_names="${purged_link_names} ${_link}"
done

# PASS 2, the unit files, which ARE in their packages' file lists.
purged_units=0
for _path in /usr/lib/systemd/system/*.timer /usr/lib/systemd/system/*.service \
             /etc/systemd/system/*.timer /etc/systemd/system/*.service; do
    { [ -e "${_path}" ] || [ -L "${_path}" ]; } || continue
    owned_by_purged "${_path}" || continue
    rm -f "${_path}"
    purged_units=$((purged_units + 1))
done

# TWO COUNTERS AND TWO GUARDS, because the first version had one guard and it
# passed for the wrong reason: it counted UNITS, the same loop removed units
# successfully, and the step's actual subject -- the enablement -- was skipped
# entirely while the number looked healthy. A non-vacuity counter has to count
# the thing the step exists to do.
[ "${purged_links}" -gt 0 ] ||
    { echo "error: no enablement link under /etc/systemd/system/*.target.wants resolves to a unit owned by ${PURGED_PACKAGES}, so this removed no enablement at all. apt enables apt-daily.timer and apt-daily-upgrade.timer and dpkg enables dpkg-db-backup.timer in every image this repository builds; a zero here means the ownership test is reading the wrong path -- the LINK rather than its target is how it read wrong the first time" >&2; exit 1; }
[ "${purged_units}" -gt 0 ] ||
    { echo "error: no unit file under /usr/lib/systemd/system or /etc/systemd/system is owned by ${PURGED_PACKAGES}, so this removed no unit. Both packages ship timers and services in every image here; a zero means dpkg-query answered nothing -- a database already removed, or a path spelling it does not recognise" >&2; exit 1; }
echo "purge: ${purged_links} enablement link(s) removed:${purged_link_names}"
echo "purge: ${purged_units} unit file(s) owned by ${PURGED_PACKAGES} removed with them"

rm -rf /var/lib/dpkg /var/lib/apt /var/cache/apt /var/cache/debconf \
       /var/log/apt \
       /etc/apt /etc/dpkg /usr/lib/apt /usr/lib/dpkg /usr/share/debconf \
       /usr/share/perl /usr/share/perl5 \
       /usr/bin/dpkg /usr/bin/dpkg-deb /usr/bin/dpkg-divert \
       /usr/bin/dpkg-maintscript-helper /usr/bin/dpkg-query \
       /usr/bin/dpkg-split /usr/bin/dpkg-statoverride /usr/bin/dpkg-trigger \
       /usr/sbin/dpkg-preconfigure /usr/sbin/dpkg-reconfigure \
       /usr/bin/apt /usr/bin/apt-cache /usr/bin/apt-cdrom /usr/bin/apt-config \
       /usr/bin/apt-get /usr/bin/apt-key /usr/bin/apt-mark /usr/bin/apt-sortpkgs \
       /usr/bin/gpgv /usr/bin/perl /usr/bin/perl5.* \
       /usr/lib/*-linux-gnu/perl-base /usr/lib/*-linux-gnu/libapt-pkg.so.* \
       /usr/lib/*-linux-gnu/libapt-private.so.*
rm -f /var/log/dpkg.log /var/log/alternatives.log \
      /usr/bin/debconf /usr/bin/debconf-apt-progress /usr/bin/debconf-communicate \
      /usr/bin/debconf-copydb /usr/bin/debconf-escape /usr/bin/debconf-set-selections \
      /usr/bin/debconf-show /usr/bin/deb-systemd-helper /usr/bin/deb-systemd-invoke \
      /usr/bin/ucf /usr/bin/ucfq /usr/bin/ucfr \
      /usr/sbin/adduser /usr/sbin/deluser /usr/sbin/addgroup /usr/sbin/delgroup \
      /usr/sbin/update-rc.d /usr/sbin/dpkg-fsys-usrunmess \
      /usr/sbin/pam-auth-update /usr/sbin/pam_getenv
# WHAT IS NO LONGER IN THAT LIST, and why the absence is the statement.
#
# It carried linux-base's four helpers (linux-check-removal, linux-run-hooks,
# linux-update-symlinks, linux-version), /usr/sbin/update-initramfs,
# veritysetup, cryptsetup, integritysetup and
# /etc/initramfs-tools/hooks/mica-verity. Every one of them was uefi-x64's, and only
# uefi-x64's: that board took Debian's linux-image-amd64, which cannot read the
# dm-mod.create= verity table, so an initramfs re-implemented it and
# initramfs-tools, cryptsetup-bin and linux-base arrived with the kernel and
# board packages. Since PLAN-074 uefi-x64 installs mica-kernel-uefi-x64 -- a bzImage, its
# config and its modules, no Depends, no maintainer script -- so none of those
# packages is on either board and none of those paths can exist. A purge of
# paths nothing can create reads like a safeguard and is not one.
# The by-name check on the ownership sweep above. It names the three units this
# tree has actually seen, so it is narrower than the sweep on purpose: the sweep
# is the general statement and this is the instance that would notice the sweep
# breaking. It no longer removes anything -- that would make it the cure and the
# test at once, and a check that fixes what it is checking cannot fail.
left="$(find /etc/systemd /usr/lib/systemd -name 'apt-daily*' -o -name 'dpkg-db-backup*' 2>/dev/null | tr '\n' ' ')"
[ -z "${left}" ] ||
    { echo "error: package-management timers survived the purge: ${left}. They are enabled, they fire daily, and every one of them fails on an image with no apt and no dpkg -- which is noise in the journal shaped exactly like a real fault" >&2; exit 1; }
for gone in dpkg dpkg-query apt apt-get perl; do
    if command -v "${gone}" >/dev/null 2>&1; then
        echo "error: ${gone} survived the package-manager purge; the packed root still carries a way to install software" >&2; exit 1
    fi
done
for kept in bash sh ls cp mv rm sed awk grep find systemctl dropbear; do
    command -v "${kept}" >/dev/null 2>&1 ||
        { echo "error: the purge removed ${kept}, which the image needs at runtime" >&2; exit 1; }
done
test -s /etc/ssl/certs/ca-certificates.crt ||
    { echo "error: the purge removed the CA bundle. It is a GENERATED file, not a shipped one -- update-ca-certificates writes it from /usr/share/ca-certificates -- so anything that sweeps package-manager output can take it, and the loss is silent until the first HTTPS connection" >&2; exit 1; }
dangling="$(grep -rlI '^#!.*perl' /usr/bin /usr/sbin /usr/lib/systemd /etc 2>/dev/null || true)"
[ -z "${dangling}" ] ||
    { echo "error: perl is gone but these scripts still name it as their interpreter: ${dangling}" >&2; exit 1; }
kept_copyrights="$(find /usr/share/doc -name copyright -type f 2>/dev/null | wc -l)"
[ "${kept_copyrights}" -ge 100 ] ||
    { echo "error: only ${kept_copyrights} copyright files are left under /usr/share/doc; Debian ships them to satisfy redistribution terms" >&2; exit 1; }
echo "package management removed; ${kept_copyrights} copyright files kept"
