#!/usr/bin/env bash
# Offline contract tests for hwinit/hwinit-mac, the script that
# gives this board's Ethernet ports a stable MAC address.
#
# THE PROPERTY IS STABILITY UNDER RENAMING, and it is the property because the
# names are not stable. This board boots net.ifnames=0, so `eth0` and `eth1` are
# the order the two NICs registered in and nothing else; on the first hardware
# boot (2026-09-08) the on-board GMAC registered at 11.6657 s and the RTL8168
# behind PCIe at 11.6711 s, four and a half milliseconds apart. So the same
# silicon at the same place on the board must get the same address whether it is
# called eth0 or eth1, and two ports must never be given one address.
#
# It is DRIVEN FROM THE FAILING SIDE, and the failing side is produced from the
# shipped script rather than transcribed beside it: case 2 rewrites the one
# expression that changed -- the md5 input -- back to the interface name, which
# is what this file used to hash, and requires the swapped fixture to come out
# with the two addresses exchanged. A hand-written copy of the old derivation
# would only test the copy.
#
# WHAT THE FIXTURE MODELS. /sys/class/net/<iface> is a symlink into
# /sys/devices, and the `device` entry inside it is a second symlink up to the
# port's own device. Both are reproduced, because the derivation is exactly the
# path that pair resolves to -- `platform/2a220000.ethernet` for the GMAC,
# `platform/22000000.pcie/…/0000:01:00.0` for the PCIe part -- and a fixture
# that stored the string instead would be asserting against its own answer.
# MICA_MAC_SYSFS and MICA_MAC_CONF exist for this and are unset on a device;
# busybox(1) is a stub on PATH, so the real script's real command line is what
# is read back. The image carries no iproute2, so a bare ip(8) is a stub too,
# and calling it is a failure rather than a reach into the host.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT=$HERE/../package/hwinit/hwinit-mac
RULE=$HERE/../package/hwinit/60-mica-mac-stable.rules
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

[ -r "$SCRIPT" ] || { echo "no $SCRIPT to test" >&2; exit 1; }
[ -r "$RULE" ] || { echo "no $RULE to test" >&2; exit 1; }

CASES=0
fail() { echo "FAIL $*" >&2; exit 1; }

# The board's two Ethernet ports, by where they are attached. Taken from the
# 2026-09-08 boot log: `rk_gmac-dwmac 2a220000.ethernet eth0` and
# `r8168 0000:01:00.0`.
GMAC=platform/2a220000.ethernet
PCIE=platform/22000000.pcie/pci0000:00/0000:00:00.0/0000:01:00.0
SEED='0x15010041424344450123456789abcdef'

# One case: a fresh fake sysfs, a seed file, a conf that points at it and a
# `busybox ip` that records instead of configuring.
new_case() {
    CASE=$WORK/$1
    mkdir -p "$CASE/sys/class/net" "$CASE/sys/devices" "$CASE/bin"
    printf '%s\n' "$SEED" >"$CASE/cid"
    printf 'seed=%s\n' "$CASE/cid" >"$CASE/mac.conf"
    IPLOG=$CASE/ip.log
    : >"$IPLOG"
    cat >"$CASE/bin/busybox" <<'IPSTUB'
#!/bin/sh
[ "$1" = ip ] || { echo "busybox $*: not the ip applet" >&2; exit 1; }
shift
echo "$*" >>"$MICA_TEST_IPLOG"
exit "${MICA_TEST_IP_STATUS:-0}"
IPSTUB
    cat >"$CASE/bin/ip" <<'IPSTUB'
#!/bin/sh
echo "ip $*" >>"$MICA_TEST_IPLOG.bare"
exit 1
IPSTUB
    chmod 0755 "$CASE/bin/busybox" "$CASE/bin/ip"
}

# A NIC: an interface name, and the device path it hangs off. `net/<iface>` under
# the device, a `device` link back up to it, and the /sys/class/net symlink --
# the same three objects sysfs presents.
mknic() {
    local iface=$1 devpath=$2 assign=${3:-1}
    local d=$CASE/sys/devices/$devpath/net/$iface
    mkdir -p "$d"
    printf '%s\n' "$assign" >"$d/addr_assign_type"
    ln -sfn ../.. "$d/device"
    ln -sfn "../../devices/$devpath/net/$iface" "$CASE/sys/class/net/$iface"
}

# Run the real script the way both of its callers do, with no cwd assumption.
run_mac() {
    ( cd / && PATH=$CASE/bin:$PATH MICA_TEST_IPLOG=$IPLOG \
        MICA_TEST_IP_STATUS=${IP_STATUS:-0} \
        MICA_MAC_CONF=$CASE/mac.conf MICA_MAC_SYSFS=$CASE/sys \
        sh "${MAC_SCRIPT:-$SCRIPT}" "$@" ) 2>"$CASE/stderr"
}

# What the script told ip(8) to put on one interface, or the empty string.
address_of() {
    sed -n "s/^link set dev $1 address //p" "$IPLOG" | tail -n1
}

# --- 1. the same port gets the same address under either name ---------------

new_case names-in-order
mknic eth0 "$GMAC"
mknic eth1 "$PCIE"
run_mac
in_order_gmac=$(address_of eth0)
in_order_pcie=$(address_of eth1)
[ -n "$in_order_gmac" ] && [ -n "$in_order_pcie" ] \
    || fail "case 1: the sweep assigned nothing (eth0='$in_order_gmac' eth1='$in_order_pcie'); stderr: $(cat "$CASE/stderr")"

new_case names-swapped
mknic eth1 "$GMAC"
mknic eth0 "$PCIE"
run_mac
swapped_gmac=$(address_of eth1)
swapped_pcie=$(address_of eth0)

[ "$in_order_gmac" = "$swapped_gmac" ] \
    || fail "the GMAC at $GMAC got $in_order_gmac when it was called eth0 and $swapped_gmac when it was called eth1; the address follows the name, not the hardware"
[ "$in_order_pcie" = "$swapped_pcie" ] \
    || fail "the PCIe port at $PCIE got $in_order_pcie when it was called eth1 and $swapped_pcie when it was called eth0; the address follows the name, not the hardware"
CASES=$((CASES + 1))

# --- 2. the old derivation fails that, and the mutation is of the real file --

MUTANT=$WORK/hwinit-mac.by-name
sed 's/"\$seed" "\$topology"/"$seed" "$iface"/' "$SCRIPT" >"$MUTANT"
cmp -s "$SCRIPT" "$MUTANT" \
    && fail "the by-name mutation changed nothing in $SCRIPT, so case 2 is asserting against the current derivation and cannot go red"
sh -n "$MUTANT" || fail "the by-name mutant is not valid shell"

new_case mutant-in-order
mknic eth0 "$GMAC"
mknic eth1 "$PCIE"
MAC_SCRIPT=$MUTANT run_mac
mutant_eth0=$(address_of eth0)
mutant_eth1=$(address_of eth1)
[ -n "$mutant_eth0" ] && [ -n "$mutant_eth1" ] \
    || fail "case 2: the mutant assigned nothing, so it is not exercising the derivation"

new_case mutant-swapped
mknic eth1 "$GMAC"
mknic eth0 "$PCIE"
MAC_SCRIPT=$MUTANT run_mac
[ "$(address_of eth0)" = "$mutant_eth0" ] && [ "$(address_of eth1)" = "$mutant_eth1" ] \
    || fail "the by-name mutant did not reproduce the defect: swapping the two names should hand each port the other's address"
[ "$mutant_eth0" != "$in_order_gmac" ] || [ "$mutant_eth1" != "$in_order_pcie" ] \
    || fail "the by-name mutant produced the shipped script's addresses, so case 1 would pass under the old derivation too"
CASES=$((CASES + 1))

# --- 3. two ports never collide ---------------------------------------------

[ "$in_order_gmac" != "$in_order_pcie" ] \
    || fail "both ports were given $in_order_gmac"
CASES=$((CASES + 1))

# --- 4. the derivation itself, pinned ---------------------------------------
#
# Recorded rather than recomputed: a test that hashes the same two strings the
# same way agrees with any formula the script happens to have. These are the
# addresses this board's two ports get from the seed above, and a change to the
# md5 input, the slicing or the 02: prefix moves them.

expect_gmac=$(printf '%s-%s' "$SEED" "$GMAC" | md5sum | awk \
    '{h=$1;printf "02:%s:%s:%s:%s:%s",substr(h,1,2),substr(h,3,2),substr(h,5,2),substr(h,7,2),substr(h,9,2)}')
[ "$in_order_gmac" = "02:07:1b:c0:f8:a8" ] \
    || fail "the derivation moved: the GMAC at $GMAC with this seed is recorded as 02:07:1b:c0:f8:a8 and came out $in_order_gmac (md5 of 'seed-topology' would give $expect_gmac). Every deployed unit's address changes with it"
[ "$in_order_pcie" = "02:5c:cc:6e:7f:8e" ] \
    || fail "the derivation moved: the PCIe port at $PCIE with this seed is recorded as 02:5c:cc:6e:7f:8e and came out $in_order_pcie"
CASES=$((CASES + 1))

# --- 5. a port with a real address is never touched -------------------------

new_case permanent
mknic eth0 "$GMAC" 0
mknic eth1 "$PCIE" 3
run_mac
[ -z "$(address_of eth0)" ] \
    || fail "a NET_ADDR_PERM port was given $(address_of eth0); its address is burned into the part"
[ -z "$(address_of eth1)" ] \
    || fail "a NET_ADDR_SET port was given $(address_of eth1); somebody else already owns that address"
CASES=$((CASES + 1))

# --- 6. no device link: skipped, and it says so -----------------------------

new_case virtual
mknic eth0 "$GMAC"
mkdir -p "$CASE/sys/devices/virtual/net/eth9"
printf '1\n' >"$CASE/sys/devices/virtual/net/eth9/addr_assign_type"
ln -sfn ../../devices/virtual/net/eth9 "$CASE/sys/class/net/eth9"
run_mac
[ -n "$(address_of eth0)" ] || fail "case 6: the real port was not assigned"
[ -z "$(address_of eth9)" ] \
    || fail "an interface with no device link was given $(address_of eth9); there is no topology under it to derive one from"
grep -q 'eth9 has no' "$CASE/stderr" \
    || fail "eth9 was skipped without saying why; stderr was: $(cat "$CASE/stderr")"
CASES=$((CASES + 1))

# --- 7. the udev path: one name, that port only -----------------------------
#
# The interface that appears late is the one the one-shot sweep cannot reach, so
# the rule hands the script a single name. It must assign that port and leave
# the rest of /sys/class/net alone.

new_case late-arrival
mknic eth0 "$GMAC"
mknic eth1 "$PCIE"
run_mac eth1
[ "$(address_of eth1)" = "$in_order_pcie" ] \
    || fail "the udev path gave $PCIE '$(address_of eth1)'; the sweep gives it $in_order_pcie and the two callers must agree"
[ -z "$(address_of eth0)" ] \
    || fail "hwinit-mac eth1 also wrote to eth0"
CASES=$((CASES + 1))

# --- 8. the rule hands it a name, and the scope holds ------------------------

grep -q 'RUN+="/usr/lib/mica/hwinit-mac %k"' "$RULE" \
    || fail "$RULE does not run the installed hwinit-mac with the kernel name; case 7 is then testing a call nothing makes"

new_case scope
mknic eth0 "$GMAC"
mknic wlan0 "$PCIE"
run_mac wlan0
[ -z "$(address_of wlan0)" ] \
    || fail "hwinit-mac assigned wlan0; its scope is eth* and the radio's address is not this program's to choose"
CASES=$((CASES + 1))

# --- 9. a refused write is reported, not swallowed --------------------------

new_case ip-fails
mknic eth0 "$GMAC"
IP_STATUS=1 run_mac
grep -q "could not set $in_order_gmac" "$CASE/stderr" \
    || fail "ip(8) refused the address and nothing said so; stderr was: $(cat "$CASE/stderr")"
CASES=$((CASES + 1))

# --- 10. no iproute2: the write goes through busybox --------------------------

for bare in "$WORK"/*/ip.log.bare; do
    [ -e "$bare" ] || continue
    fail "hwinit-mac called a bare ip(8), which this image does not carry: $(cat "$bare")"
done
CASES=$((CASES + 1))

echo "PASS mac-stable-test: ${CASES} cases"
