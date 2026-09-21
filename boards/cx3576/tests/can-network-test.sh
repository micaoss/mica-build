#!/usr/bin/env bash
# Offline contract tests for hwinit/hwinit-can, which turns /etc/mica/can.conf
# into the systemd-networkd [CAN] configuration of the board's CAN interface.
# The image carries no iproute2: networkd sets the bitrate, restart delay and
# FD mode, and brings the link up, whenever the interface registers.
#
# MICA_CAN_CONF and MICA_CAN_NETWORK_DIR exist for this and are unset on a
# device. networkctl, systemctl and ip are stubs on PATH: the first two record
# their argv, and an `ip` call is a failure, so the real script's real command lines are what
# is read back and no host interface is ever touched.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SCRIPT=$HERE/../package/hwinit/hwinit-can
UNIT=$HERE/../package/hwinit/mica-can.service
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

CASES=0
fail() { echo "FAIL $*" >&2; exit 1; }

new_case() {
    CASE=$WORK/$1
    mkdir -p "$CASE/bin" "$CASE/network"
    : >"$CASE/calls"
    for tool in networkctl systemctl ip; do
        cat >"$CASE/bin/$tool" <<STUB
#!/bin/sh
echo "$tool \$*" >>"$CASE/calls"
case "$tool" in
networkctl) exit "\${MICA_TEST_NETWORKCTL_STATUS:-0}" ;;
systemctl) exit "\${MICA_TEST_NETWORKD_ACTIVE:-0}" ;;
esac
exit 1
STUB
        chmod 0755 "$CASE/bin/$tool"
    done
}

run_can() {
    local status=0
    ( cd / && PATH=$CASE/bin:$PATH MICA_CAN_CONF=$CASE/can.conf \
        MICA_CAN_NETWORK_DIR=$CASE/network sh "$SCRIPT" ) 2>"$CASE/stderr" || status=$?
    [ "$status" = 0 ] || fail "$CASE: hwinit-can exited $status; it is best-effort and always exits 0"
}

network=10-mica-can.network

# --- 1. the shipped configuration --------------------------------------------

new_case shipped
cp "$HERE/../package/init/can.conf" "$CASE/can.conf"
run_can
expected=$(printf '%s\n' '[Match]' 'Name=can0' '' '[CAN]' 'BitRate=250000' 'RestartSec=100ms' 'FDMode=off')
[ "$(cat "$CASE/network/$network" 2>/dev/null)" = "$expected" ] \
    || fail "case 1: the shipped can.conf rendered '$(cat "$CASE/network/$network" 2>/dev/null)', expected '$expected'"
grep -q '^ip ' "$CASE/calls" && fail "case 1: hwinit-can called ip; the image has no iproute2"
grep -qx 'networkctl reload' "$CASE/calls" \
    || fail "case 1: networkd was not asked to reload the rendered configuration; calls: $(cat "$CASE/calls")"
CASES=$((CASES + 1))

# --- 2. defaults, and fd only when set -----------------------------------------

new_case defaults
printf '%s\n' 'interface=can1' >"$CASE/can.conf"
run_can
expected=$(printf '%s\n' '[Match]' 'Name=can1' '' '[CAN]' 'BitRate=500000' 'RestartSec=100ms')
[ "$(cat "$CASE/network/$network" 2>/dev/null)" = "$expected" ] \
    || fail "case 2: defaults rendered '$(cat "$CASE/network/$network" 2>/dev/null)', expected '$expected'"
CASES=$((CASES + 1))

# --- 3. no conf, or no interface: nothing is rendered, and an earlier render goes

new_case no-conf
printf 'stale\n' >"$CASE/network/$network"
run_can
[ ! -e "$CASE/network/$network" ] || fail "case 3: a configuration survived its can.conf"

new_case no-interface
printf '%s\n' 'bitrate=125000' >"$CASE/can.conf"
run_can
[ ! -e "$CASE/network/$network" ] || fail "case 3: a configuration was rendered with no interface= to match"
CASES=$((CASES + 1))

# --- 4. networkd is only asked when it runs, and a failed ask is not a failure

new_case networkd-not-running
cp "$HERE/../package/init/can.conf" "$CASE/can.conf"
MICA_TEST_NETWORKD_ACTIVE=3 run_can
[ -s "$CASE/network/$network" ] || fail "case 4: nothing rendered before networkd runs"
grep -q '^networkctl ' "$CASE/calls" \
    && fail "case 4: networkctl was called with networkd not running; the bus call would activate networkd ahead of network-pre.target"

new_case networkd-down
cp "$HERE/../package/init/can.conf" "$CASE/can.conf"
MICA_TEST_NETWORKCTL_STATUS=1 run_can
[ -s "$CASE/network/$network" ] || fail "case 4: nothing rendered when networkctl failed"
CASES=$((CASES + 1))

# --- 5. the unit renders before networkd starts --------------------------------

grep -qx 'Before=network-pre.target' "$UNIT" \
    || fail "$UNIT is not ordered before network-pre.target; networkd could configure the link before its [CAN] settings exist"
CASES=$((CASES + 1))

echo "PASS can-network-test: ${CASES} cases"
