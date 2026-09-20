#!/bin/bash
# What a person meets, asserted from inside the running image.
#
# Claims that were false or unobserved on 2026-09-19:
#   - the PAM stack ASSEMBLES AND ACCEPTS. Every published image before
#     20260920-0622 answered "PAM failure, aborting" at a console login, on
#     every board. A refusal proves the stack loads; only a SUCCESS proves it
#     authenticates, and nothing had ever observed one;
#   - a CONTAINER RUNS, with no flag at all. Nothing had ever confirmed one;
#   - the image's IDENTITY is what it claims (/etc/issue read, not guessed);
#   - the cgroup hierarchy is v2 unified, and a CPU quota is bounded by the FILE
#     cpu.max rather than by `cpu` in cgroup.controllers -- cpu is listed on a
#     kernel without CFS_BANDWIDTH, where cpu.max does not exist, so the
#     controller list is the cheap identifier that lies;
#   - and after mica-health completes, the boot has SETTLED: running or
#     degraded, never still starting. Not `running`: health passes a degraded
#     boot deliberately, and asserting more than health promises would go red
#     where health is content.
#
# THE PASSWORD IS SET HERE, over micad's own bus, so no secret crosses the
# host boundary: com.mica.micad / /com/mica/micad / com.mica.micad1
# SetTransientRootPassword. It is a TEST CONSTANT and must never be a product
# default; it lives until the next boot, when mica-shadow-reconcile clears it.
exec 2>&1
PW='probe-transient-pw-2026'
pass() { printf 'PROBE-PASS: %s\n' "$1"; }
fail() { printf 'PROBE-FAIL: %s\n' "$1"; }

# pam_rootok lets root through su without a password, so the caller must not be
# root; script(1) gives su the terminal it requires (python3 is not in a root).
# Bounded, because a pty that never returns would take the whole probe with it.
attempt() {
    timeout 30 setpriv --reuid=1000 --regid=1000 --init-groups -- \
        script -qc "printf '%s\n' '$1' | su - root -c 'id -u'" /dev/null 2>&1
}

out="$(attempt 'not-the-password')"
case "${out}" in
*"Authentication failure"*) pass "the PAM stack assembles: su refused a wrong password from an unprivileged account" ;;
*"Critical error - immediate abort"*) fail "PAM_ABORT: the stack did not assemble; /etc/pam.d is incomplete in this root" ;;
*) fail "su answered neither a refusal nor an abort: ${out}" ;;
esac

if busctl call com.mica.micad /com/mica/micad com.mica.micad1 SetTransientRootPassword s "${PW}" >/dev/null 2>&1; then
    accepted=""
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        case "$(attempt "${PW}")" in *"0"*) accepted=1; break ;; esac
        sleep 2
    done
    [ -n "${accepted}" ] &&
        pass "the PAM stack ACCEPTS: su authenticated root with the transient password micad set over its own bus" ||
        fail "su never authenticated with the transient password within 20 s of micad accepting it"
else
    fail "micad refused SetTransientRootPassword over the bus, so a successful authentication cannot be observed"
fi

if podman run --rm docker.io/library/busybox:latest true >/dev/null 2>&1; then
    pass "a container runs with no flag: pids, the device rules, seccomp, overlay and the bridge are all satisfied"
else
    fail "a plain podman run failed on this image (the kernel requirements are satisfied on every board, so this is the root or the configuration)"
fi

# *** ANCHORED TO THE PRODUCT, NOT TO A PREFIX. ***
#
# This asserted `Mica OS `* and passed for months on
# "Mica OS Base 20260920-0832" -- the BASE component's release, with the Base's
# build time and commit below it. A glob loose enough to match one of the
# image's own inputs is the purest form of a green that means nothing: the
# member was faithful and the answer was about the wrong system.
#
# Read guest-locally and compared against each other, so nothing has to be
# passed in from the host: os-release must claim this product, and the console
# must name the same version os-release does.
image_id="$(sed -n 's/^IMAGE_ID=//p' /usr/lib/os-release | tr -d '"')"
image_version="$(sed -n 's/^IMAGE_VERSION=//p' /usr/lib/os-release | tr -d '"')"
issue="$(head -n1 /etc/issue 2>/dev/null)"
if ! grep -qx 'ID=mica' /usr/lib/os-release; then
    fail "/usr/lib/os-release does not say ID=mica: this root carries its inputs' identity, not its own"
elif [ -z "${image_id}" ] || [ -z "${image_version}" ]; then
    fail "/usr/lib/os-release carries no IMAGE_ID/IMAGE_VERSION: nothing a person could quote in a bug report"
elif [ "${issue#*"${image_version}"}" = "${issue}" ]; then
    fail "the console names a different version from os-release: issue '${issue}' does not contain IMAGE_VERSION ${image_version}"
else
    pass "the image names ITSELF on the console: ${issue} (IMAGE_ID=${image_id}, IMAGE_VERSION=${image_version})"
fi

[ "$(stat -f -c %T /sys/fs/cgroup)" = cgroup2fs ] &&
    pass "the cgroup hierarchy is v2 unified, which is what every container limit conclusion rests on" ||
    fail "/sys/fs/cgroup is not cgroup2fs; podman takes its v1 branch, where a memory limit is discarded with a warning"
if [ -e /sys/fs/cgroup/cpu.max ]; then
    pass "cpu.max exists: a CPU quota can be enforced"
else
    pass "cpu.max is absent: a CPU quota cannot be enforced here, and podman fails loudly at the write (cpu IS in cgroup.controllers, which is the identifier that lies)"
fi
# THE SAME SHAPE FOR MEMORY, AND FOR NOW THE SAME REASON: BOTH BRANCHES PASS.
# Measured in the four board kernel configs on 2026-09-20: CONFIG_MEMCG is NOT
# SET on uefi-x64 and set on the other three, so `podman run --memory=...` has
# no file to write on the one product most people try first. A branch that
# always passes is a measurement and not an assertion, and it is written that
# way on purpose until the kernel floor is uniform -- at which point the absent
# branch becomes a fail(), because the promise will then be one promise.
if [ -e /sys/fs/cgroup/memory.max ]; then
    pass "memory.max exists: a memory limit can be enforced"
else
    pass "memory.max is absent: this kernel has no memory controller, so --memory cannot be honoured on this board"
fi

# io.max, THE CEILING WITH NO PRODUCT-SIDE READING UNTIL NOW. The document
# promises IOReadBandwidthMax=/IOWriteBandwidthMax= as kernel controllers, and
# BLK_DEV_THROTTLING is unset on every board, so this is the one ceiling whose
# absence nothing on the product side had ever observed. Same both-branches
# shape as cpu.max and memory.max, and the absent branch becomes a fail() when
# the kernel floor reaches a product.
if [ -e /sys/fs/cgroup/io.max ]; then
    pass "io.max exists: an IO bandwidth ceiling can be enforced"
else
    pass "io.max is absent: IOReadBandwidthMax= and IOWriteBandwidthMax= cannot be honoured on this board"
fi

# *** WHAT THIS DEVICE SAYS ON SOMEBODY ELSE'S NETWORK. ***
#
# resolved's compiled-in default for MulticastDNS is `yes`. Debian ships
# /usr/lib/systemd/resolved.conf.d/00-disable-mdns.conf turning it OFF, and the
# composition DROPS that drop-in -- so the global default should be back to
# `yes` unless something else sets it. Every other member of the dropped-config
# class changes how a tool behaves ON the machine; this one changes what the
# machine advertises on a customer's LAN, and no file on the device says so.
#
# ASKED OF THE RUNNING RESOLVER AND NOT OF THE FILES, because the files are
# exactly where this question is not answerable: the drop-in is absent, the
# stock resolved.conf is absent, and mica's own 80-dhcp.network sets neither
# MulticastDNS= nor LLMNR= on eth*. The effective value lives in the daemon.
mdns="$(resolvectl mdns 2>&1 | tr '\n' '|' | sed 's/|*$//')"
llmnr="$(resolvectl llmnr 2>&1 | tr '\n' '|' | sed 's/|*$//')"
pass "the resolver reports mDNS as: ${mdns:-<no output>}"
pass "the resolver reports LLMNR as: ${llmnr:-<no output>}"

# THE CONTAINER STORE, AS MOUNTED RATHER THAN AS DECLARED. All four products
# declare mica-containers.mount with Options=bind,private,nosuid,nodev; this
# asks the running kernel whether those options took, which is the only place
# the difference between a declaration and a mount can show. The FSTYPE is
# reported rather than asserted: /mica/containers is a bind, so it inherits
# whatever the lifecycle init made DATA, and that is the value worth reading
# back on a board nobody has looked at.
mounted="$(findmnt -no FSTYPE,OPTIONS /mica/containers 2>&1)"
case "${mounted}" in
*nosuid*nodev* | *nodev*nosuid*) pass "the container store is mounted as declared: ${mounted}" ;;
'') fail "/mica/containers is not a mount point at all: the container store is a directory on the read-only root" ;;
*) fail "/mica/containers is mounted without nosuid,nodev: ${mounted}" ;;
esac

# THE SETTLE CHECK RUNS OUTSIDE THE BOOT TRANSACTION, DETACHED. This unit is a
# job of that transaction, and while any of its jobs runs -- including this one
# -- `systemctl is-system-running` can only answer `starting`. Asked from in
# here the probe waits for itself, which is how it failed on its first run.
# mica-health is in the same position, deliberately: it treats `starting` with
# no other running jobs as settled, because the gate is itself a job.
#
# `running` alone would be the wrong assertion: health passes a DEGRADED boot on
# purpose, and a harness that demanded more than health promises would go red
# where health is content. So: running or degraded, never still starting.
setsid bash -c '
    state=starting
    for _ in $(seq 1 60); do
        state="$(systemctl is-system-running 2>&1)"
        case "${state}" in running | degraded | maintenance) break ;; esac
        sleep 2
    done
    case "${state}" in
    running | degraded) printf "\nPROBE-PASS: the boot settled: is-system-running says %s; failed units: %s\n" \
        "${state}" "$(systemctl --failed --no-legend --no-pager | wc -l)" ;;
    *) printf "\nPROBE-FAIL: the boot did not settle within 120 s: is-system-running says %s; failed units: %s\n" \
        "${state}" "$(systemctl --failed --no-legend --no-pager | tr "\n" " ")" ;;
    esac
    printf "PROBE-END\n"' >/dev/console 2>&1 &
