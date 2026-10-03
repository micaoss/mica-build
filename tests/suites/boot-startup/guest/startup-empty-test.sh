#!/bin/bash
# Execute the real static startup binary with no loader, libraries or helpers.
# Run as container PID1; no devices are opened and mount must return EPERM.
set -euo pipefail
test "$$" = 1
binary=${1:?explicit same-source static mica-runkit required}
mkdir -p /empty/proc
cp "$binary" /empty/init
status=0
chroot /empty /init > /tmp/startup-public.log 2>&1 || status=$?
test "$status" = 1
grep -Fx 'mica-init must run as PID 1' /tmp/startup-public.log
status=0
chroot /empty /init --startup-worker '{"Mount":{"source":"proc","target":"/proc","kind":"proc","options":"nosuid,nodev,noexec"}}' > /tmp/startup-mount.log 2>&1 || status=$?
test "$status" = 1
grep -F 'Operation not permitted' /tmp/startup-mount.log
test "$(find /empty -type f -printf '%P\n')" = init
printf '%s\n' STATIC_STARTUP_EMPTY_USERSPACE_PASS
