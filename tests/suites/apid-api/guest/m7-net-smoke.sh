#!/bin/bash
# the kernel half of VLAN, bridge and WireGuard, proved by USING it
# on a booted device rather than by reading a config file.
#
# This runs INSIDE the guest. verify USED to carry two kernel checks reading
# `/boot/config-*` and the module indexes out of an unpacked squashfs -- a claim
# about what the image CONTAINS. src/verify/checks-kernel.ts was deleted on
# 2026-09-09 in 1875d133 and nothing replaced it, so verify reads no kernel
# config today. Either way nothing offline can answer whether the running kernel
# will actually hand back a device. Creating one is the only
# thing that asks that question, and it has to be asked where the kernel is.
# The image carries no `ip`: the devices are declared to systemd-networkd as
# runtime .netdev files and removed with `networkctl delete`.
#
# Every conclusion is one `M7-SMOKE: <id> PASS|FAIL <detail>` line on the
# console, which is the harness's only channel into this guest: the image keeps
# journald at `Storage=volatile` and there is no login and no route in. The
# suite reads these lines back out of the captured serial log.
#
# Kernel-only links and the permission probe file are removed. The managed
# WireGuard fixture remains on the disposable QEMU disk until harness teardown.

set -u

# Dispatch after micad owns its bus name when invoked outside the seeded test unit.
if [ "${M7_AFTER_MICAD:-0}" != 1 ]; then
    exec systemd-run --no-block --unit=mica-e2e-net-smoke \
        --property=After=micad.service --property=Requires=micad.service \
        --property=StandardOutput=journal+console --property=StandardError=journal+console \
        --setenv=M7_AFTER_MICAD=1 /bin/bash "$0"
fi

STATE_DIR=/var/lib/mica
KEY_DIR="${STATE_DIR}/networkd-secrets"
SECRETS_DIR="${STATE_DIR}/secrets"
NET_USER=systemd-network

# Names nothing else in this suite writes; a
# collision would make one phase's teardown another phase's failure.
VLAN_ID=4094
BRIDGE_DEV=m7br0
WG_DEV=m7wg0

say() { echo "M7-SMOKE: $*"; }
pass() { say "$1 PASS ${2-}"; }
fail() { say "$1 FAIL ${2-}"; }

# `set -u` plus a subshell would hide a failure; each check reports its own
# verdict and none of them aborts the script, because a run that stopped at the
# first red would report nothing about the checks after it and the console would
# look identical to a run that never started.

# `wait_for <seconds> <command...>`: poll until the command succeeds.
#
# Three things this script needs are produced by other units racing it, and on
# a TCG guest it wins that race routinely: STATE is mounted by local-fs.target,
# a network interface is named by systemd-networkd, and <state>/secrets/ is
# created by micad's first-boot provisioning. Measured 2026-08-28: this unit
# reached its first check 54s into the boot with none of the three ready, and
# every conclusion drawn then described the CLOCK rather than the image.
# The limits are SHORT because this unit runs after sysinit.target and holds
# the rest of the boot while it runs: every second spent here is a second micad,
# apid and the suite's own readiness deadline do not get.
wait_for() {
    local limit="$1"; shift
    local i=0
    while [ "$i" -lt "$limit" ]; do
        if "$@" >/dev/null 2>&1; then return 0; fi
        i=$((i + 1))
        sleep 1
    done
    return 1
}

state_is_mounted() { mountpoint -q "${STATE_DIR}"; }

say "BEGIN $(uname -r)"

if wait_for 60 state_is_mounted; then
    pass state-mounted "${STATE_DIR} is a mount point"
else
    fail state-mounted "${STATE_DIR} was not mounted within 60s; the key-store checks below cannot run"
fi

# 1. modprobe resolution, against the running kernel's own view. `-n` is a dry
# run: it resolves the name and the dependency chain and loads nothing, which is
# what makes this safe to run before the link checks that need the real thing.
for m in 8021q bridge wireguard; do
    if out=$(modprobe -n "$m" 2>&1); then
        pass "modprobe-${m}" "modprobe -n ${m} resolved${out:+ (${out})}"
    else
        fail "modprobe-${m}" "modprobe -n ${m} failed: ${out}"
    fi
done

# 2. The links, declared as runtime networkd files (/run/systemd/network) and
# deleted again. Nothing here disturbs the NIC: the bridge takes no ports, the
# VLAN hangs off that bridge rather than off the uplink (a VLAN= line in the
# uplink's .network would reconfigure it and drop the port forward the rest of
# the suite needs), and the tunnel is created from nothing.
RUNTIME_NET=/run/systemd/network
VLAN_DEV="${BRIDGE_DEV}.${VLAN_ID}"
mkdir -p "${RUNTIME_NET}"

link_check() {
    local id="$1" dev="$2" out
    if ! out=$(networkctl reload 2>&1); then
        fail "$id" "networkctl reload failed: ${out}"
    elif wait_for 15 test -e "/sys/class/net/${dev}"; then
        pass "$id" "$(networkctl list --no-pager --no-legend "${dev}" 2>&1)"
    else
        # networkd took the declaration and the kernel handed back no device.
        fail "$id" "${dev} was declared to systemd-networkd and did not appear within 15s: $(journalctl -b -u systemd-networkd --no-pager -n 5 2>&1 | tr '\n' ' ')"
    fi
}

cat >"${RUNTIME_NET}/10-m7-smoke-bridge.netdev" <<EOF
[NetDev]
Name=${BRIDGE_DEV}
Kind=bridge
EOF
link_check link-bridge "${BRIDGE_DEV}"

cat >"${RUNTIME_NET}/10-m7-smoke-bridge.network" <<EOF
[Match]
Name=${BRIDGE_DEV}

[Network]
VLAN=${VLAN_DEV}
EOF
cat >"${RUNTIME_NET}/10-m7-smoke-vlan.netdev" <<EOF
[NetDev]
Name=${VLAN_DEV}
Kind=vlan

[VLAN]
Id=${VLAN_ID}
EOF
if [ -e "/sys/class/net/${BRIDGE_DEV}" ]; then
    link_check link-vlan "${VLAN_DEV}"
else
    fail link-vlan "the parent ${BRIDGE_DEV} does not exist (see link-bridge), so there is nothing to declare a VLAN on"
fi

# networkd ignores a WireGuard netdev without a private key; any 32 bytes are one.
cat >"${RUNTIME_NET}/10-m7-smoke-wg.netdev" <<EOF
[NetDev]
Name=${WG_DEV}
Kind=wireguard

[WireGuard]
PrivateKey=$(head -c 32 /dev/urandom | base64)
EOF
link_check link-wireguard "${WG_DEV}"

rm -f "${RUNTIME_NET}"/10-m7-smoke-*
networkctl reload >/dev/null 2>&1
networkctl delete "${VLAN_DEV}" "${BRIDGE_DEV}" "${WG_DEV}" >/dev/null 2>&1

# 3. The traversal check handed forward.
#
# Run AS the user, never by reading mode bits. The M5 defect the amendment
# corrected -- a key under a 0700 `secrets/` -- left every mode assertion green
# while `PrivateKeyFile=` was EACCES on every real image, because the mode of
# the key says nothing about whether its PATH can be walked. `setpriv
# --reuid/--regid --clear-groups` drops to the account systemd-networkd runs as
# and the kernel answers the question that mode bits cannot.
if ! id "${NET_USER}" >/dev/null 2>&1; then
    fail netuser-exists "no ${NET_USER} account on this image; micad's key store chowns to a group that does not exist and PrivateKeyFile= could not be read by anyone but root"
else
    pass netuser-exists "$(id "${NET_USER}")"

    NET_UID=$(id -u "${NET_USER}")
    NET_GID=$(id -g "${NET_USER}")
    as_netuser() { setpriv --reuid "${NET_UID}" --regid "${NET_GID}" --clear-groups -- "$@"; }

    # The fixture is written at the production path with the production modes,
    # so what is being read is the store's own directory rather than a lookalike
    # somewhere traversable. A key micad generated would be a stronger subject
    # still, but it exists only once a wireguard interface has been configured,
    # and a check that depended on another phase's timing would report EACCES
    # for "not created yet". Both are asserted: the fixture unconditionally, and
    # every real key beside it when there is one.
    FIXTURE="${KEY_DIR}/m7-probe.key"
    mkdir -p "${KEY_DIR}" 2>/dev/null
    chmod 0750 "${KEY_DIR}" 2>/dev/null
    chown "root:${NET_USER}" "${KEY_DIR}" 2>/dev/null
    printf 'not-a-key\n' >"${FIXTURE}" 2>/dev/null
    chmod 0640 "${FIXTURE}" 2>/dev/null
    chown "root:${NET_USER}" "${FIXTURE}" 2>/dev/null

    if out=$(as_netuser cat "${FIXTURE}" 2>&1); then
        pass keystore-readable "${NET_USER} read ${FIXTURE} (mode $(stat -c '%a %U:%G' "${FIXTURE}" 2>/dev/null)); every path component is traversable by that user"
    else
        fail keystore-readable "${NET_USER} could NOT read ${FIXTURE} (mode $(stat -c '%a %U:%G' "${FIXTURE}" 2>/dev/null)): ${out}. systemd-networkd would fail PrivateKeyFile= with the same error and every mode assertion in micad's own tests would still be green"
    fi
    rm -f "${FIXTURE}"

    # Ask micad to generate the key through its real settings/reconcile path.
    # This tunnel has no peers or default route and does not change the NIC.
    managed_key="${KEY_DIR}/wg-wg-e2e0.key"
    if ! busctl --timeout=15 call com.mica.micad /com/mica/micad com.mica.micad1 \
        SetSettings ss network.wg-e2e0 '{"kind":"wireguard","dhcp":false,"wireguard":{}}' >/dev/null; then
        fail keystore-real-readable "micad refused the managed WireGuard fixture"
    elif ! wait_for 30 test -s "${managed_key}"; then
        fail keystore-real-readable "micad generated no key for wg-e2e0 within 30s"
    elif as_netuser cat "${managed_key}" >/dev/null 2>&1; then
        pass keystore-real-readable "${NET_USER} read the key micad generated at ${managed_key} (mode $(stat -c '%a %U:%G' "${managed_key}" 2>/dev/null))"
    else
        fail keystore-real-readable "${NET_USER} could NOT read micad's key at ${managed_key}"
    fi

    # The negative, and it is not decoration. If `systemd-network` could read
    # `secrets/` then the amendment's whole premise -- that a key cannot live
    # under it -- would be false, and the path correction this milestone
    # verifies would have been unnecessary. A check that only ever asserts
    # access cannot tell a correctly scoped grant from a wide-open state dir.
    # NOT a wait. This unit runs immediately after sysinit.target and BLOCKS the
    # rest of the boot -- micad has not started yet and is the only thing that
    # creates secrets/, so waiting for it here deadlocks the two: measured
    # 2026-08-28, a 120s poll for this directory held multi-user.target for the
    # whole 120s and micad could not run until it gave up.
    #
    # So the directory is made when it is absent, at the mode identity.rs pins
    # (0700, root-owned), and removed again. On the second boot of a disk micad
    # has already provisioned it and the real one is used untouched -- the
    # detail below says which was read, because "the shipped directory refuses
    # this user" and "a directory with the shipped mode refuses this user" are
    # different claims and a reader must not have to guess.
    secrets_fixture=0
    if [ ! -d "${SECRETS_DIR}" ]; then
        mkdir -p "${SECRETS_DIR}" 2>/dev/null && chmod 0700 "${SECRETS_DIR}" 2>/dev/null \
            && chown root:root "${SECRETS_DIR}" 2>/dev/null \
            && printf 'not-a-password\n' >"${SECRETS_DIR}/device-password" 2>/dev/null \
            && chmod 0600 "${SECRETS_DIR}/device-password" 2>/dev/null \
            && secrets_fixture=1
    fi
    secrets_origin="the directory micad provisioned"
    [ "${secrets_fixture}" -eq 1 ] && secrets_origin="a fixture at the mode identity.rs:44 pins, micad not having provisioned yet on this boot"

    if [ ! -d "${SECRETS_DIR}" ]; then
        fail secrets-unreadable "${SECRETS_DIR} does not exist and could not be created on this boot"
    elif as_netuser cat "${SECRETS_DIR}/device-password" >/dev/null 2>&1; then
        fail secrets-unreadable "${NET_USER} CAN read ${SECRETS_DIR}/device-password (dir mode $(stat -c '%a %U:%G' "${SECRETS_DIR}" 2>/dev/null), ${secrets_origin}); the plaintext device password is readable by the network account"
    else
        pass secrets-unreadable "${NET_USER} cannot read ${SECRETS_DIR}/device-password (dir mode $(stat -c '%a %U:%G' "${SECRETS_DIR}" 2>/dev/null), ${secrets_origin}), which is why the key store is a SIBLING of secrets/ and not a directory under it"
    fi
    [ "${secrets_fixture}" -eq 1 ] && rm -rf "${SECRETS_DIR}"
fi

say "END"
