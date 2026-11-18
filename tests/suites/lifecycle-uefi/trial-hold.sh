#!/bin/sh
# The trial deadline acceptance (trial-deadline.sh): /var/lib/mica/trial-hold names a deployment and a mode, and a
# boot of that deployment is held at a stage, so it is never confirmed by the health gate:
#   <id>          held before the health gate (test-trial-hold, the stage "gate")
#   <id> confirm  confirmed at once by `mica-deploy confirm`, then held before the runtime acceptance
#   <id> early    held in the boot runlevel before mica-data-layout (OpenRC; the stage "early")
# Any other boot, or a deployment not named, passes at once. A held boot prints to the console every 10 s and
# copies mica-trial-deadline's lines there.
set -u
stage=${1:-gate}
# Before mica-data-layout binds /var/lib/mica, the file is where the runkit mounted DATA.
marker=/var/lib/mica/trial-hold
[ -r "$marker" ] || marker=/mnt/data/state/mica/trial-hold
read -r hold mode 2>/dev/null <"$marker" || [ -n "${hold:-}" ] || exit 0
booted=$(mica-deploy booted 2>/dev/null) || exit 0
[ -n "$hold" ] && [ "$booted" = "$hold" ] || exit 0
case "$stage:${mode:-}" in
    gate:) ;;
    gate:confirm) mica-deploy confirm >/dev/console 2>&1 && echo "FILE_AB_TRIAL_CONFIRMED: $booted, up $(cut -d. -f1 /proc/uptime) s" >/dev/console ;;
    early:early) ;;
    *) exit 0 ;;
esac
if [ -d /run/systemd/system ]; then journalctl -b -f -o cat -u mica-trial-deadline.service >/dev/console 2>&1 &
else { logread -f 2>/dev/null || tail -F /var/log/messages 2>/dev/null; } | grep --line-buffered mica-trial-deadline >/dev/console 2>&1 &
fi
while :; do echo "FILE_AB_TRIAL_HOLD: $booted held (${mode:-gate}), up $(cut -d. -f1 /proc/uptime) s" >/dev/console; sleep 10; done
