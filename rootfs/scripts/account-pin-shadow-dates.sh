#!/bin/sh
# Pin the shadow last-change day of EVERY account to the build's epoch.
#
# Called from rootfs/compose/90-pack.Dockerfile (closed stage), where the
# reasoning lives.

set -eu
# The same instant boards/<board>/board.env pins FILE_MTIME to and the same
# day the three Mica OS accounts already carry, so there is one answer in the tree
# to "when was this root made" rather than a second one for accounts.
PINNED_DATE=2020-01-01
PINNED_DAY=18262

# Every account, not a list of the four that move today. systemd-network,
# messagebus and systemd-resolve are the ones Debian's postinsts create
# now; the next package to ship a system account would arrive unpinned and
# nothing here would say so. The property is "no account dates itself", and a
# name list is not that property.
users="$(cut -d: -f1 /etc/shadow)"
n=0
for u in ${users}; do
    chage -d "${PINNED_DATE}" "${u}"
    n=$((n + 1))
done
[ "${n}" -gt 0 ] ||
    { echo "error: /etc/shadow named no accounts, so this pinned nothing and every check downstream would pass over an empty set" >&2; exit 1; }

# The SECOND pass is not a mistake. /etc/shadow- is the snapshot chage takes
# BEFORE it writes, so after one pass the backup still holds the unpinned row of
# whichever account happened to be pinned last -- measured on trixie: pass one
# left /etc/shadow reading 18262 for every account while /etc/shadow- still read
# 20696 for the last of them. A second pass writes nothing new to /etc/shadow
# and makes the backup a snapshot of the already-pinned state.
for u in ${users}; do
    chage -d "${PINNED_DATE}" "${u}"
done

# Both files, because both ship: /etc/shadow becomes the factory copy in the
# pack stage and /etc/shadow- stays in /etc as a regular file. Checked here as
# well as over the packed tree, so a chage that silently declined an account is
# a failure at the step that caused it.
for f in /etc/shadow /etc/shadow-; do
    [ -f "${f}" ] || continue
    bad="$(awk -F: -v want="${PINNED_DAY}" '$1 != "" && $3 != want { printf " %s=%s", $1, $3 }' "${f}")"
    [ -z "${bad}" ] ||
        { echo "error: after pinning, ${f} still carries a last-change day other than ${PINNED_DAY}:${bad}. That field is the DAY the account was made, so a root carrying it differs between two builds run on different days" >&2; exit 1; }
done
echo "accounts: pinned the shadow last-change day of ${n} accounts to ${PINNED_DAY} (${PINNED_DATE})"
