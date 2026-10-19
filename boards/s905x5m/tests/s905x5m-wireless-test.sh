#!/usr/bin/env bash
# Exercise each radio selection against the production transport initializer.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/bin"
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$MODULE_LOG"\n' > "$work/bin/modprobe"
chmod +x "$work/bin/modprobe"
touch "$work/power"
cat > "$work/wireless.conf" <<EOF
power-control=$work/power
platform-module=amlogic-wireless
transport-modules=skw_sdio
wifi-module=skw
interface=lo
bt-transport=/dev/null
vhci=/dev/null
wait-seconds=0
EOF
for selection in wifi bluetooth both neither; do
    rm -f "$work/wifi.conf" "$work/bluetooth.conf"
    : > "$work/modules"
    case "$selection" in wifi|both) touch "$work/wifi.conf";; esac
    case "$selection" in bluetooth|both) touch "$work/bluetooth.conf";; esac
    PATH="$work/bin:$PATH" MODULE_LOG="$work/modules" MICA_CONF="$work/wireless.conf" \
        sh "$repo/extras/wireless/hwinit/hwinit-wireless"
    if [[ "$selection" = wifi || "$selection" = both ]]; then
        grep -qx -- '-q skw' "$work/modules"
    else ! grep -qx -- '-q skw' "$work/modules"; fi
    if [[ "$selection" = bluetooth || "$selection" = both ]]; then
        grep -qx -- '-q hci_vhci' "$work/modules"
    else ! grep -qx -- '-q hci_vhci' "$work/modules"; fi
    [[ "$selection" != neither ]] || test ! -s "$work/modules"
done
echo 'S905X5M_RADIO_SELECTION_PASS'
