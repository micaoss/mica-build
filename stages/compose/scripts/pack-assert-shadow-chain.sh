#!/bin/sh
# Assert the whole shadow chain, including that no account carries a usable hash.
#
# Called from stages/compose/90-pack.Dockerfile (pack stage), where the reasoning lives.

set -eu
link="$(readlink /rootfs/etc/shadow || true)"
[ "${link}" = "/run/mica/shadow" ] ||
    { echo "error: /etc/shadow is '${link:-not a symlink}', expected a symlink to /run/mica/shadow" >&2; exit 1; }
grep -qx 'Where=/var/lib/mica' /rootfs/etc/systemd/system/var-lib-mica.mount ||
    { echo "error: the /etc/shadow symlink target is not the Where= of var-lib-mica.mount, so it is not STATE-backed" >&2; exit 1; }
fac=/rootfs/usr/share/factory/etc/shadow
test -f "${fac}"
mode="$(stat -c %a "${fac}")"
[ "${mode}" = "640" ] || { echo "error: factory shadow is mode ${mode}, expected 640" >&2; exit 1; }
sg="$(awk -F: '$1 == "shadow" { print $3 }' /rootfs/etc/group)"
test -n "${sg}"
own="$(stat -c '%u:%g' "${fac}")"
[ "${own}" = "0:${sg}" ] ||
    { echo "error: factory shadow is owned ${own}, expected 0:${sg} (root:shadow); unix_chkpwd needs egid shadow to read it" >&2; exit 1; }
grep -q '^root:' "${fac}" || { echo "error: factory shadow has no root: entry" >&2; exit 1; }
rh="$(awk -F: '$1 == "root" { print $2; exit }' "${fac}")"
case "${rh}" in
    "") echo "error: the root: entry in the factory shadow has an EMPTY hash field, which means PASSWORDLESS root login: pam_unix accepts any password, including none. Empty is not a locked marker; only '!' (including '!!' and '!'-prefixed forms that retain a hash) and '*' lock an account" >&2; exit 1 ;;
    '!'* | '*'*) ;;
    *) echo "error: the packed rootfs carries a usable root password hash. A signed rootfs is byte-identical on every device, so this is a fleet-wide shared secret. Something in the build wrote a root credential; the rootfs build has no ROOT_PASSWORD build arg on purpose, and root access is provisioned at runtime (micad's transient password)" >&2; exit 1 ;;
esac
missing=""; empty=""; hashed=""
while IFS=: read -r u _; do
    [ -n "${u}" ] || continue
    line="$(grep "^${u}:" "${fac}" | head -n1)"
    if [ -z "${line}" ]; then missing="${missing} ${u}"; continue; fi
    h="$(printf '%s' "${line}" | cut -d: -f2)"
    case "${h}" in
        "") empty="${empty} ${u}" ;;
        '!'* | '*'*) ;;
        *) hashed="${hashed} ${u}" ;;
    esac
done < /rootfs/etc/passwd
[ -z "${missing}" ] ||
    { echo "error: accounts in /etc/passwd with no factory shadow entry:${missing}" >&2; exit 1; }
[ -z "${empty}" ] ||
    { echo "error: account(s) in the factory shadow with an EMPTY password field:${empty}. An empty field means PASSWORDLESS login -- pam_unix accepts any password, including none. Empty is not a locked marker; only '!' (including '!!' and '!'-prefixed forms that retain a hash) and '*' lock an account" >&2; exit 1; }
[ -z "${hashed}" ] ||
    { echo "error: account(s) in the factory shadow carrying a usable password hash:${hashed}. A signed rootfs is byte-identical on every device in the fleet, so any hash baked into one is a shared secret by construction. Passwords are provisioned per device at runtime, never in the image" >&2; exit 1; }
unit=/rootfs/etc/systemd/system/mica-shadow-reconcile.service
test -f "${unit}"
test -x /rootfs/usr/lib/mica/mica-shadow-reconcile
test -L /rootfs/etc/systemd/system/multi-user.target.wants/mica-shadow-reconcile.service ||
    { echo "error: mica-shadow-reconcile.service is installed but not enabled; /etc/shadow would never converge with the image accounts" >&2; exit 1; }
# ORDERED BEFORE EVERY READER, not after a mount. The reconciler used to
# require var-lib-mica.mount because the shadow file lived on STATE; it now
# builds the file in /run, which systemd has already mounted, so there is
# no storage dependency left to order against.
#
# What must be asserted instead is that nothing reads /etc/shadow before it
# exists. If this ordering is lost the failure is not a wrong password --
# it is PAM finding no shadow file at all, which fails closed for every
# account including the transient root the operator is trying to use.
for reader in micad.service dropbear.service systemd-logind.service; do
    grep -qE "^Before=.*\\b${reader}\\b" "${unit}" ||
        { echo "error: mica-shadow-reconcile.service does not order Before=${reader}; that reader would find no /etc/shadow at all, because the file is built in RAM by this unit" >&2; exit 1; }
done
if grep -qE '^After=.*var-lib-mica' "${unit}"; then
    echo "error: mica-shadow-reconcile.service still orders After=var-lib-mica.mount, but it no longer touches STATE -- the shadow file is built in /run. A storage dependency that is not needed delays the unit behind a mount that can fail." >&2; exit 1
fi
for dep in micad.service dropbear.service; do
    grep -qE "^Before=.*\b${dep}\b" "${unit}" ||
        { echo "error: mica-shadow-reconcile.service does not order Before=${dep}" >&2; exit 1; }
done
test -f /rootfs/etc/systemd/system/dropbear.service ||
    { echo "error: mica-shadow-reconcile.service orders Before=dropbear.service but that unit is not in the image; systemd drops such an ordering silently" >&2; exit 1; }
# The last-change day, read back out of the PACKED TREE rather than trusted from
# the step that set it. It is the day the account was created, so an unpinned
# one is the build date sitting inside the verity-covered root; the pin is
# account-pin-shadow-dates.sh in the `closed` stage.
#
# BOTH files, because both ship and they are not the same file: the factory copy
# is what mica-shadow-reconcile derives /etc/shadow from, while /etc/shadow- is
# useradd's pre-modification backup, which keeps its own rows and lagged the pin
# by one pass until the pin was made to run twice.
#
# The count is printed and a zero is refused. "No account carries a build date"
# over a file this loop never managed to read is true of every root that has
# ever existed, and this check exists precisely because the failure it looks for
# is invisible until two builds straddle midnight.
PINNED_DAY=18262
examined=0
for f in "${fac}" /rootfs/etc/shadow-; do
    [ -f "${f}" ] ||
        { echo "error: ${f} is not in the packed tree, so the last-change assertion below would skip it. Both shadow files ship and both carry the field; if one has been removed on purpose, this check has to be told" >&2; exit 1; }
    rows="$(awk -F: '$1 != ""' "${f}" | wc -l)"
    moving="$(awk -F: -v want="${PINNED_DAY}" '$1 != "" && $3 != want { printf " %s=%s", $1, $3 }' "${f}")"
    [ -z "${moving}" ] ||
        { echo "error: ${f} carries a shadow last-change day other than ${PINNED_DAY}:${moving}. That field is the DAY the account was made -- the build date, reaching a signed root through a maintainer script -- so two builds on different days produce different roots and a different dm-verity root hash" >&2; exit 1; }
    examined=$((examined + rows))
done
[ "${examined}" -gt 0 ] ||
    { echo "error: the last-change assertion examined ${examined} accounts. A check over an empty set passes forever" >&2; exit 1; }

echo "shadow: symlink -> STATE, factory copy 0640 0:${sg}, root locked, reconcile unit enabled and ordered"
echo "shadow: last-change day ${PINNED_DAY} on all ${examined} account rows across the factory copy and /etc/shadow-"
